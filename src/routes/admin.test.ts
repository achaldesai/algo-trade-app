import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { describe, it, before, after, beforeEach } from "node:test";
import adminRouter from "./admin";
import errorHandler from "../middleware/errorHandler";
import env from "../config/env";
import type { AppContainer } from "../container";

const API_KEY = "test-admin-key";
const BACKUP = "/data/backups/portfolio-2026-11-01";

const restoreCalls: string[] = [];
let getStatsImpl: () => Promise<unknown>;
let restoreImpl: (p: string) => Promise<void>;

const container = {
  dbManager: {
    getStats: () => getStatsImpl(),
    listBackups: async () => [BACKUP],
    restoreFromBackup: async (p: string) => {
      restoreCalls.push(p);
      return restoreImpl(p);
    },
  },
} as unknown as AppContainer;

describe("/api/admin routes", () => {
  let server: Server;
  let base: string;
  const originalKey = env.adminApiKey;

  const call = (method: string, url: string, body?: unknown, key: string | null = API_KEY) =>
    fetch(`${base}${url}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(key ? { "x-admin-api-key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });

  before(async () => {
    env.adminApiKey = API_KEY;
    const app = express();
    app.use(express.json());
    app.locals.container = container;
    app.use("/api/admin", adminRouter);
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    env.adminApiKey = originalKey;
    server.close();
  });

  beforeEach(() => {
    restoreCalls.length = 0;
    getStatsImpl = async () => ({ entries: 1 });
    restoreImpl = async () => undefined;
  });

  it("requires admin credentials", async () => {
    assert.equal((await call("GET", "/api/admin/db-stats", undefined, null)).status, 401);
    assert.equal((await call("GET", "/api/admin/db-stats", undefined, "wrong")).status, 403);
  });

  it("returns 500 instead of crashing when a handler's dependency throws", async () => {
    getStatsImpl = async () => {
      throw new Error("disk full");
    };
    const res = await call("GET", "/api/admin/db-stats");
    assert.equal(res.status, 500);
    // Server is still alive for the next request.
    getStatsImpl = async () => ({ entries: 1 });
    assert.equal((await call("GET", "/api/admin/db-stats")).status, 200);
  });

  describe("POST /restore", () => {
    it("restores a listed backup", async () => {
      const res = await call("POST", "/api/admin/restore", { backupPath: BACKUP });
      assert.equal(res.status, 200);
      assert.deepEqual(restoreCalls, [BACKUP]);
    });

    it("rejects a path that is not a listed backup with 400", async () => {
      const res = await call("POST", "/api/admin/restore", { backupPath: "/etc" });
      assert.equal(res.status, 400);
      assert.deepEqual(restoreCalls, []);
    });

    it("rejects a missing body field with 400", async () => {
      const res = await call("POST", "/api/admin/restore", {});
      assert.equal(res.status, 400);
      assert.deepEqual(restoreCalls, []);
    });

    it("returns 500 when the restore itself fails", async () => {
      restoreImpl = async () => {
        throw new Error("copy failed");
      };
      const res = await call("POST", "/api/admin/restore", { backupPath: BACKUP });
      assert.equal(res.status, 500);
    });
  });
});
