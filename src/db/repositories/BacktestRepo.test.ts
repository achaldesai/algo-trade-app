import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseManager } from "../DatabaseManager";
import { BacktestRepo, MAX_RUNS_PER_USER } from "./BacktestRepo";
import type { BacktestRun } from "../../services/BacktestService";

let seq = 0;
function makeRun(userId: string, overrides: Partial<BacktestRun> = {}): BacktestRun {
  seq++;
  return {
    id: `${(1_700_000_000_000 + seq).toString(36).padStart(9, "0")}-abc`,
    userId,
    createdAt: new Date().toISOString(),
    strategyId: "ma-crossover",
    strategyName: "MA",
    symbols: ["TCS"],
    from: "2024-01-01",
    to: "2024-12-31",
    params: {},
    initialCapital: 1000,
    costBps: 10,
    metrics: {} as BacktestRun["metrics"],
    equityCurve: [{ date: "2024-01-01", equity: 1000 }],
    trades: [],
    rejections: [],
    warnings: [],
    ...overrides,
  };
}

describe("BacktestRepo", () => {
  let root: string;
  let db: DatabaseManager;
  let repo: BacktestRepo;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "backtest-repo-"));
    db = new DatabaseManager(path.join(root, "store"));
    await db.open();
    repo = new BacktestRepo(db);
  });

  afterEach(async () => {
    await db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("saves, lists newest first without the heavy fields, gets and deletes", async () => {
    const first = makeRun("alice");
    const second = makeRun("alice");
    await repo.save(first);
    await repo.save(second);

    const list = repo.list("alice");
    assert.deepEqual(list.map((r) => r.id), [second.id, first.id]);
    assert.equal("equityCurve" in list[0], false);
    assert.equal("trades" in list[0], false);

    assert.deepEqual(repo.get("alice", first.id)?.equityCurve, first.equityCurve);
    assert.equal(await repo.delete("alice", first.id), true);
    assert.equal(await repo.delete("alice", first.id), false);
    assert.equal(repo.get("alice", first.id), undefined);
  });

  it("isolates users, including ones whose id is a prefix of another", async () => {
    const run = makeRun("al");
    await repo.save(run);
    await repo.save(makeRun("alice"));

    assert.equal(repo.list("al").length, 1);
    assert.equal(repo.get("alice", run.id), undefined);
    assert.equal(await repo.delete("alice", run.id), false);
  });

  it(`keeps only the newest ${MAX_RUNS_PER_USER} runs per user`, async () => {
    const runs = Array.from({ length: MAX_RUNS_PER_USER + 3 }, () => makeRun("bob"));
    await repo.save(makeRun("carol"));
    for (const run of runs) await repo.save(run);

    const ids = repo.list("bob").map((r) => r.id);
    assert.equal(ids.length, MAX_RUNS_PER_USER);
    assert.equal(ids[0], runs.at(-1)!.id);
    assert.equal(repo.get("bob", runs[2].id), undefined, "oldest trimmed");
    assert.equal(repo.list("carol").length, 1, "other users untouched");
  });
});
