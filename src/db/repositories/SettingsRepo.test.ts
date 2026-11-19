import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseManager } from "../DatabaseManager";
import { DEFAULT_PAPER_STARTING_CASH, SettingsRepo, type RiskLimits } from "./SettingsRepo";

const defaults: RiskLimits = {
  maxDailyLoss: 1000,
  maxDailyLossPercent: 2,
  maxPositionSize: 10_000,
  maxOpenPositions: 5,
  stopLossPercent: 2,
};

describe("SettingsRepo paper starting cash", () => {
  let root: string;
  let db: DatabaseManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "settings-repo-"));
    db = new DatabaseManager(path.join(root, "store"));
    await db.open();
  });

  afterEach(async () => {
    await db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("defaults to ₹1,00,000, is per user, and survives a reload", async () => {
    const repo = new SettingsRepo(db, defaults);
    repo.load();
    assert.equal(repo.getPaperStartingCash("alice"), DEFAULT_PAPER_STARTING_CASH);

    await repo.savePaperStartingCash("alice", 5000);
    assert.equal(repo.getPaperStartingCash("alice"), 5000);
    assert.equal(repo.getPaperStartingCash("bob"), DEFAULT_PAPER_STARTING_CASH);

    const reloaded = new SettingsRepo(db, defaults);
    reloaded.load();
    assert.equal(reloaded.getPaperStartingCash("alice"), 5000);
    assert.deepEqual(reloaded.getRiskLimits("alice"), defaults, "not mistaken for risk limits");
  });

  it("keeps auto-start trading off by default, and persists it when switched on", async () => {
    const repo = new SettingsRepo(db, defaults);
    repo.load();
    assert.equal(repo.getAutoStartTrading(), false);
    await repo.saveAutoStartTrading(true);
    assert.equal(repo.getAutoStartTrading(), true);

    const reloaded = new SettingsRepo(db, defaults);
    reloaded.load();
    assert.equal(reloaded.getAutoStartTrading(), true);
    assert.deepEqual(reloaded.getRiskLimits("alice"), defaults, "not mistaken for risk limits");
  });
});
