import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { DatabaseManager } from "./DatabaseManager";

describe("DatabaseManager backup/restore", () => {
  let root: string;
  let storePath: string;
  let db: DatabaseManager;

  // A single settings record is enough to tell which copy of the store is live.
  const putLimit = (maxDailyLoss: number) =>
    db.handles.settings.put("risk-limits", {
      maxDailyLoss,
      maxDailyLossPercent: 2,
      maxPositionSize: 100000,
      maxOpenPositions: 5,
      stopLossPercent: 2,
    });
  const getLimit = () =>
    (db.handles.settings.get("risk-limits") as { maxDailyLoss?: number } | undefined)?.maxDailyLoss;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dbm-test-"));
    storePath = path.join(root, "portfolio-store");
    db = new DatabaseManager(storePath);
    await db.open();
  });

  afterEach(async () => {
    await db.close();
    await fs.chmod(root, 0o755).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("restores data from a backup and leaves no staging dirs behind", async () => {
    await putLimit(1000);
    const backup = await db.createBackup();
    await putLimit(9999);
    assert.equal(getLimit(), 9999);

    await db.restoreFromBackup(backup);

    assert.equal(db.isOpen, true);
    assert.equal(getLimit(), 1000);
    const leftovers = (await fs.readdir(root)).filter((n) => n.includes(".restore-") || n.includes(".pre-restore-"));
    assert.deepEqual(leftovers, []);
  });

  it("writes a single LMDB snapshot file, not a copy of the live dir", async () => {
    await putLimit(1000);
    const backup = await db.createBackup();
    assert.deepEqual(await fs.readdir(backup), ["data.mdb"]);
  });

  it("takes a consistent snapshot while writes continue", async () => {
    const settings = db.handles.settings;
    await Promise.all(Array.from({ length: 500 }, (_, i) => settings.put(`k${i}`, { maxDailyLoss: i } as never)));

    const writes = (async () => {
      for (let i = 500; i < 800; i++) await settings.put(`k${i}`, { maxDailyLoss: i } as never);
    })();
    const backup = await db.createBackup();
    await writes;

    const copy = new DatabaseManager(backup);
    await copy.open();
    try {
      const keys = [...copy.handles.settings.getKeys()].filter((k) => String(k).startsWith("k"));
      // Snapshot holds a prefix of the writes: k0..k(n-1), with no gaps.
      assert.ok(keys.length >= 500, `expected at least the initial 500 keys, got ${keys.length}`);
      for (let i = 0; i < keys.length; i++) {
        assert.ok(copy.handles.settings.get(`k${i}`), `missing k${i} in a ${keys.length}-key snapshot`);
      }
    } finally {
      await copy.close();
    }
  });

  it("refuses to back up a closed store", async () => {
    await db.close();
    await assert.rejects(db.createBackup(), /not open/);
    await db.open();
  });

  it("leaves no listed backup behind when the backup fails", { skip: process.getuid?.() === 0 }, async () => {
    await db.createBackup();
    const backupDir = path.join(root, "backups");
    await fs.chmod(backupDir, 0o555);
    try {
      await assert.rejects(db.createBackup());
    } finally {
      await fs.chmod(backupDir, 0o755);
    }
    assert.equal((await db.listBackups()).length, 1);
    assert.deepEqual((await fs.readdir(backupDir)).filter((n) => n.startsWith(".partial-")), []);
  });

  it("lists backups newest first", async () => {
    const first = await db.createBackup();
    await new Promise((r) => setTimeout(r, 5));
    const second = await db.createBackup();
    assert.deepEqual(await db.listBackups(), [second, first]);
  });

  it("rejects paths outside the backups directory", async () => {
    await putLimit(1234);
    const outside = path.join(root, "portfolio-evil");
    await fs.mkdir(outside);

    await assert.rejects(db.restoreFromBackup(outside), /Not a backup/);
    await assert.rejects(db.restoreFromBackup(path.join(root, "backups", "..", "portfolio-store")), /Not a backup/);
    assert.equal(getLimit(), 1234);
  });

  it("rejects a missing backup without touching the live store", async () => {
    await putLimit(1234);
    const missing = path.join(root, "backups", "portfolio-does-not-exist");
    await assert.rejects(db.restoreFromBackup(missing), /Backup not found/);
    assert.equal(db.isOpen, true);
    assert.equal(getLimit(), 1234);
  });

  it("keeps the live data when copying the backup fails", { skip: process.getuid?.() === 0 }, async () => {
    await putLimit(1000);
    const backup = await db.createBackup();
    await putLimit(5555);

    // Make one file in the backup unreadable so fs.cp fails part-way.
    const [file] = (await fs.readdir(backup)).filter((n) => !n.endsWith("-lock"));
    await fs.chmod(path.join(backup, file), 0o000);

    try {
      await assert.rejects(db.restoreFromBackup(backup));
    } finally {
      await fs.chmod(path.join(backup, file), 0o644);
    }

    assert.equal(db.isOpen, true);
    assert.equal(getLimit(), 5555);
  });
});
