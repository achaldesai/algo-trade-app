import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { describe, it, beforeEach, afterEach } from "node:test";
import type { Request, Response } from "express";
import { userAuthMiddleware, requireRole } from "./userAuth";
import { adminAuthMiddleware } from "./adminAuth";
import { HttpError } from "../utils/HttpError";
import env from "../config/env";

const SECRET = "test-secret";
const knownUsers = new Set(["u-admin", "u-user"]);

function makeReq(authorization?: string, extraHeaders: Record<string, string> = {}): Request {
  return {
    headers: { ...(authorization ? { authorization } : {}), ...extraHeaders },
    path: "/test",
    method: "GET",
    ip: "127.0.0.1",
    app: {
      locals: {
        container: {
          userRepo: { findUserById: (id: string) => (knownUsers.has(id) ? { id } : undefined) },
        },
      },
    },
  } as unknown as Request;
}

async function run(
  mw: (req: Request, res: Response, next: (err?: unknown) => void) => unknown,
  req: Request,
): Promise<unknown> {
  return new Promise((resolve) => {
    void mw(req, {} as Response, (err?: unknown) => resolve(err ?? "ok"));
  });
}

const sign = (userId: string, role: string, secret = SECRET) => `Bearer ${jwt.sign({ userId, role }, secret)}`;

describe("auth middleware", () => {
  const original = { nodeEnv: env.nodeEnv, adminApiKey: env.adminApiKey };
  beforeEach(() => {
    env.adminApiKey = SECRET;
    env.nodeEnv = "development";
  });
  afterEach(() => {
    env.adminApiKey = original.adminApiKey;
    env.nodeEnv = original.nodeEnv;
  });

  describe("userAuthMiddleware", () => {
    it("accepts a valid token and attaches the user", async () => {
      const req = makeReq(sign("u-user", "USER"));
      assert.equal(await run(userAuthMiddleware, req), "ok");
      assert.equal(req.user?.userId, "u-user");
    });

    it("rejects a missing header with 401", async () => {
      const err = await run(userAuthMiddleware, makeReq());
      assert.ok(err instanceof HttpError && err.statusCode === 401);
    });

    it("rejects a token signed with another secret", async () => {
      const err = await run(userAuthMiddleware, makeReq(sign("u-user", "USER", "other")));
      assert.ok(err instanceof HttpError && err.statusCode === 401);
    });

    it("rejects a valid token for a deleted user", async () => {
      const err = await run(userAuthMiddleware, makeReq(sign("u-gone", "USER")));
      assert.ok(err instanceof HttpError && err.statusCode === 401);
    });

    it("returns 503 in production when ADMIN_API_KEY is unset", async () => {
      env.adminApiKey = "";
      env.nodeEnv = "production";
      const err = await run(userAuthMiddleware, makeReq("Bearer anything"));
      assert.ok(err instanceof HttpError && err.statusCode === 503);
    });
  });

  describe("requireRole", () => {
    it("lets ADMIN through any role check and blocks USER from ADMIN", async () => {
      const admin = makeReq();
      admin.user = { userId: "u-admin", role: "ADMIN" };
      assert.equal(await run(requireRole("TRADER"), admin), "ok");

      const user = makeReq();
      user.user = { userId: "u-user", role: "USER" };
      const err = await run(requireRole("ADMIN"), user);
      assert.ok(err instanceof HttpError && err.statusCode === 403);
    });
  });

  describe("adminAuthMiddleware", () => {
    it("accepts an ADMIN JWT signed with the shared secret", async () => {
      assert.equal(await run(adminAuthMiddleware, makeReq(sign("u-admin", "ADMIN"))), "ok");
    });

    it("rejects a USER JWT", async () => {
      const err = await run(adminAuthMiddleware, makeReq(sign("u-user", "USER")));
      assert.ok(err instanceof HttpError && err.statusCode === 401);
    });

    it("accepts the X-Admin-API-Key header and rejects a wrong one", async () => {
      assert.equal(await run(adminAuthMiddleware, makeReq(undefined, { "x-admin-api-key": SECRET })), "ok");
      const err = await run(adminAuthMiddleware, makeReq(undefined, { "x-admin-api-key": "wrong" }));
      assert.ok(err instanceof HttpError && err.statusCode === 403);
    });
  });
});
