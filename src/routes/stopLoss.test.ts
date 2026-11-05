import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { describe, it, before, after, beforeEach } from "node:test";
import stopLossRouter from "./stopLoss";
import errorHandler from "../middleware/errorHandler";
import env from "../config/env";
import type { AppContainer } from "../container";
import type { StopLossConfig } from "../db/repositories/StopLossRepo";

const SECRET = "test-secret";
const store = new Map<string, StopLossConfig>();
let monitoring = false;
let setImpl: (() => Promise<void>) | undefined;

const key = (userId: string, symbol: string) => `${userId}:${symbol}`;

const stopLossMonitor = {
  getStatus: (userId?: string) => {
    const mine = [...store.values()].filter((c) => !userId || c.userId === userId);
    return { monitoring, activeStopLosses: mine.length, stopLosses: mine };
  },
  get: (userId: string, symbol: string) => store.get(key(userId, symbol)),
  setStopLoss: async (userId: string, symbol: string, input: Partial<StopLossConfig>) => {
    if (setImpl) await setImpl();
    const now = new Date();
    const existing = store.get(key(userId, symbol));
    const config = {
      userId,
      symbol,
      entryPrice: input.entryPrice!,
      quantity: input.quantity!,
      stopLossPrice: input.stopLossPrice ?? input.entryPrice! * 0.95,
      type: input.type ?? "FIXED",
      trailingPercent: input.trailingPercent,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } as StopLossConfig;
    store.set(key(userId, symbol), config);
    return config;
  },
  removeStopLoss: async (userId: string, symbol: string) => {
    store.delete(key(userId, symbol));
  },
  start: () => {
    monitoring = true;
  },
  stop: () => {
    monitoring = false;
  },
};

const users = new Set(["alice", "bob", "root"]);
const container = {
  stopLossMonitor,
  userRepo: { findUserById: (id: string) => (users.has(id) ? { id } : undefined) },
} as unknown as AppContainer;

const tokens = {
  alice: jwt.sign({ userId: "alice", role: "USER" }, SECRET),
  bob: jwt.sign({ userId: "bob", role: "USER" }, SECRET),
  root: jwt.sign({ userId: "root", role: "ADMIN" }, SECRET),
};

describe("/api/stop-loss routes", () => {
  let server: Server;
  let base: string;
  const original = { key: env.adminApiKey };

  const call = (method: string, url: string, token?: string, body?: unknown) =>
    fetch(`${base}/api/stop-loss${url}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });

  before(async () => {
    env.adminApiKey = SECRET;
    const app = express();
    app.use(express.json());
    app.locals.container = container;
    app.use("/api/stop-loss", stopLossRouter);
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    env.adminApiKey = original.key;
    server.close();
  });

  beforeEach(() => {
    store.clear();
    monitoring = false;
    setImpl = undefined;
  });

  it("requires a user token", async () => {
    assert.equal((await call("GET", "/")).status, 401);
  });

  it("creates, reads, updates and deletes a stop-loss for the caller", async () => {
    let res = await call("PUT", "/reliance", tokens.alice, { entryPrice: 2500, quantity: 10, stopLossPrice: 2400 });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.message, "Stop-loss created");
    assert.equal(body.data.symbol, "RELIANCE");
    assert.equal(body.data.distancePercent, 4);

    res = await call("PUT", "/RELIANCE", tokens.alice, { stopLossPrice: 2450 });
    body = await res.json();
    assert.equal(body.message, "Stop-loss updated");
    assert.equal(body.data.entryPrice, 2500, "keeps existing entry price");
    assert.equal(body.data.stopLossPrice, 2450);

    res = await call("GET", "/RELIANCE", tokens.alice);
    assert.equal(res.status, 200);

    res = await call("DELETE", "/RELIANCE", tokens.alice);
    assert.equal(res.status, 200);
    assert.equal((await call("GET", "/RELIANCE", tokens.alice)).status, 404);
  });

  it("requires entryPrice and quantity for a new stop-loss", async () => {
    const res = await call("PUT", "/TCS", tokens.alice, { stopLossPrice: 3000 });
    assert.equal(res.status, 400);
    assert.equal(store.size, 0);
  });

  it("isolates stop-losses between users", async () => {
    await call("PUT", "/TCS", tokens.alice, { entryPrice: 4000, quantity: 1 });
    assert.equal((await call("GET", "/TCS", tokens.bob)).status, 404);
    assert.equal((await call("DELETE", "/TCS", tokens.bob)).status, 404);
    const list = await (await call("GET", "/", tokens.bob)).json();
    assert.equal(list.data.activeCount, 0);
    assert.equal(store.size, 1);
  });

  it("returns 500 when the monitor fails to save", async () => {
    setImpl = async () => {
      throw new Error("lmdb write failed");
    };
    const res = await call("PUT", "/TCS", tokens.alice, { entryPrice: 4000, quantity: 1 });
    assert.equal(res.status, 500);
  });

  describe("start/stop (global monitor)", () => {
    it("is forbidden for normal users", async () => {
      assert.equal((await call("POST", "/stop", tokens.alice)).status, 401);
      assert.equal((await call("POST", "/start", tokens.alice)).status, 401);
    });

    it("is allowed for admins", async () => {
      let res = await call("POST", "/start", tokens.root);
      assert.equal(res.status, 200);
      assert.equal(monitoring, true);
      res = await call("POST", "/stop", tokens.root);
      assert.equal(res.status, 200);
      assert.equal(monitoring, false);
    });
  });
});
