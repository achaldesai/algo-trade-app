import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseManager } from "../DatabaseManager";
import { StrategyConfigRepo } from "./StrategyConfigRepo";

describe("StrategyConfigRepo symbols", () => {
  let root: string;
  let db: DatabaseManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-config-repo-"));
    db = new DatabaseManager(path.join(root, "store"));
    await db.open();
  });

  afterEach(async () => {
    await db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("persists a config's symbols across a reload, and leaves them absent when unset", async () => {
    const repo = new StrategyConfigRepo(db);
    repo.load();
    const updatedAt = new Date().toISOString();
    await repo.saveConfig("alice", { strategyId: "rsi-reversion", enabled: true, params: { sizing: "percent" }, symbols: ["TCS", "INFY"], updatedAt });
    await repo.saveConfig("alice", { strategyId: "vwap", enabled: false, params: {}, updatedAt });

    const reloaded = new StrategyConfigRepo(db);
    reloaded.load();
    assert.deepEqual(reloaded.getConfig("alice", "rsi-reversion")?.symbols, ["TCS", "INFY"]);
    assert.equal("symbols" in reloaded.getConfig("alice", "vwap")!, false);
  });

  it("hands out copies, so callers can't change the cached symbols", async () => {
    const repo = new StrategyConfigRepo(db);
    repo.load();
    await repo.saveConfig("alice", { strategyId: "rsi-reversion", enabled: true, params: {}, symbols: ["TCS"], updatedAt: "x" });
    repo.getConfig("alice", "rsi-reversion")!.symbols!.push("INFY");
    repo.getAllConfigs("alice")[0].symbols!.push("INFY");
    assert.deepEqual(repo.getConfig("alice", "rsi-reversion")?.symbols, ["TCS"]);
  });
});
