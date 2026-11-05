import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { describe, it, before, after, beforeEach } from "node:test";
import authRouter from "./auth";
import errorHandler from "../middleware/errorHandler";
import env from "../config/env";
import type { AppContainer } from "../container";

// Network-free paths only: no SmartAPI/KiteConnect call is reached in these tests.

type Token = { accessToken?: string; jwtToken?: string; userId?: string; clientId?: string; expiresAt: string };
const zerodha = new Map<string, Token>();
const angel = new Map<string, Token>();
const deleted: string[] = [];

const container = {
  tokenRepo: {
    getZerodhaToken: (id: string) => zerodha.get(id),
    getAngelOneToken: (id: string) => angel.get(id),
    deleteZerodhaToken: async (id: string) => {
      deleted.push(`zerodha:${id}`);
      zerodha.delete(id);
    },
    deleteAngelOneToken: async (id: string) => {
      deleted.push(`angel:${id}`);
      angel.delete(id);
    },
  },
  tickerClient: { isConnected: () => true },
} as unknown as AppContainer;

const future = () => new Date(Date.now() + 3600_000).toISOString();
const past = () => new Date(Date.now() - 3600_000).toISOString();

describe("/api/auth routes", () => {
  let server: Server;
  let base: string;
  const original = {
    brokerApiKey: env.brokerApiKey,
    angelOneApiKey: env.angelOneApiKey,
    angelOneClientId: env.angelOneClientId,
    angelOnePassword: env.angelOnePassword,
  };

  const call = (method: string, url: string, body?: unknown) =>
    fetch(`${base}/api/auth${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });

  before(async () => {
    const app = express();
    app.use(express.json());
    // userAuthMiddleware skips verification when req.user is already set.
    app.use((req, _res, next) => {
      req.user = { userId: "alice", role: "USER" };
      next();
    });
    app.locals.container = container;
    app.use("/api/auth", authRouter);
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    Object.assign(env, original);
    server.close();
  });

  beforeEach(() => {
    zerodha.clear();
    angel.clear();
    deleted.length = 0;
    Object.assign(env, { brokerApiKey: "", angelOneApiKey: "", angelOneClientId: "", angelOnePassword: "" });
  });

  describe("Zerodha", () => {
    it("status reports no session, then falls back to SYSTEM_DEFAULT", async () => {
      assert.equal((await (await call("GET", "/zerodha/status")).json()).authenticated, false);

      zerodha.set("SYSTEM_DEFAULT", { accessToken: "sys-token-123456", userId: "ZD1", expiresAt: future() });
      const body = await (await call("GET", "/zerodha/status")).json();
      assert.equal(body.authenticated, true);
      assert.equal(body.zerodhaUserId, "ZD1");
    });

    it("token endpoint masks the token and 404s when absent", async () => {
      assert.equal((await call("GET", "/zerodha/token")).status, 404);

      zerodha.set("alice", { accessToken: "abcd1234567890wxyz", userId: "ZD1", expiresAt: future() });
      const body = await (await call("GET", "/zerodha/token")).json();
      assert.equal(body.accessToken, "abcd****wxyz");
    });

    it("login 400s when the API key is not configured", async () => {
      assert.equal((await call("GET", "/zerodha/login")).status, 400);
    });

    it("callback POST 400s without a request token", async () => {
      assert.equal((await call("POST", "/zerodha/callback", {})).status, 400);
    });

    it("logout deletes only the caller's token", async () => {
      await call("POST", "/zerodha/logout");
      assert.deepEqual(deleted, ["zerodha:alice"]);
    });
  });

  describe("Angel One", () => {
    it("status reports ticker connectivity when a session exists", async () => {
      angel.set("SYSTEM_DEFAULT", { jwtToken: "j", clientId: "C1", expiresAt: future() });
      const body = await (await call("GET", "/angelone/status")).json();
      assert.equal(body.authenticated, true);
      assert.equal(body.tickerConnected, true);
    });

    it("login 400s when credentials are not configured", async () => {
      assert.equal((await call("POST", "/angelone/login", {})).status, 400);
    });

    it("login 400s without a TOTP when no TOTP secret is configured", async () => {
      Object.assign(env, { angelOneApiKey: "k", angelOneClientId: "c", angelOnePassword: "p", angelOneTotpSecret: "" });
      const res = await call("POST", "/angelone/login", {});
      assert.equal(res.status, 400);
      assert.match((await res.json()).message, /TOTP is required/);
    });

    it("refresh returns 404 / 400 / 401 for no session, no key, expired token", async () => {
      assert.equal((await call("POST", "/angelone/refresh")).status, 404);

      angel.set("alice", { jwtToken: "j", clientId: "C1", expiresAt: future() });
      assert.equal((await call("POST", "/angelone/refresh")).status, 400);

      env.angelOneApiKey = "k";
      angel.set("alice", { jwtToken: "j", clientId: "C1", expiresAt: past() });
      assert.equal((await call("POST", "/angelone/refresh")).status, 401);
    });

    it("keeps serving after error responses (async errors don't crash the process)", async () => {
      for (let i = 0; i < 3; i++) {
        assert.equal((await call("POST", "/angelone/refresh")).status, 404);
      }
      assert.equal((await call("GET", "/angelone/status")).status, 200);
    });
  });
});
