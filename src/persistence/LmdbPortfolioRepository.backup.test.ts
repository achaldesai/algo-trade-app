import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { LmdbPortfolioRepository } from "./LmdbPortfolioRepository";
import type { CreateStockRecord, CreateTradeRecord } from "./PortfolioRepository";

describe("LmdbPortfolioRepository - Backup/Restore", () => {
  let testDir: string;
  let repo: LmdbPortfolioRepository;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "lmdb-test-"));
    const storePath = path.join(testDir, "portfolio-store");
    repo = new LmdbPortfolioRepository(storePath);
    await repo.initialize();
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (_error) {
      // Ignore cleanup errors
    }
  });

  describe("createBackup", () => {
    it("creates a backup successfully", async () => {
      // Add some test data
      const stock: CreateStockRecord = {
        symbol: "TEST",
        name: "Test Stock",
        createdAt: new Date(),
      };
      await repo.createStock(stock);

      const trade: CreateTradeRecord = {
        id: "test-trade-1",
        symbol: "TEST",
        side: "BUY",
        quantity: 10,
        price: 100,
        executedAt: new Date(),
      };
      await repo.createTrade(trade);

      // Create backup
      const backupPath = await repo.createBackup();

      // Verify backup exists
      const backupExists = await fs.access(backupPath).then(() => true).catch(() => false);
      assert.ok(backupExists, "Backup directory should exist");

      // Verify backup contains data.mdb
      const dataMdbPath = path.join(backupPath, "data.mdb");
      const dataMdbExists = await fs.access(dataMdbPath).then(() => true).catch(() => false);
      assert.ok(dataMdbExists, "Backup should contain data.mdb");
    });

    it("creates backup with timestamp in filename", async () => {
      const backupPath = await repo.createBackup();
      const backupName = path.basename(backupPath);

      // Backup name should follow pattern: portfolio-YYYY-MM-DDTHH-MM-SS-mmmZ
      assert.match(backupName, /^portfolio-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/, "Backup name should have timestamp with milliseconds");
    });

    it("creates multiple backups without conflict", async () => {
      const backup1 = await repo.createBackup();

      // Wait a bit to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 1100));

      const backup2 = await repo.createBackup();

      assert.notEqual(backup1, backup2, "Backups should have different names");

      // Both should exist
      const backup1Exists = await fs.access(backup1).then(() => true).catch(() => false);
      const backup2Exists = await fs.access(backup2).then(() => true).catch(() => false);

      assert.ok(backup1Exists, "First backup should exist");
      assert.ok(backup2Exists, "Second backup should exist");
    });

    it("keeps only last 7 backups", async () => {
      // Create 10 backups
      const backups: string[] = [];
      for (let i = 0; i < 10; i++) {
        const backupPath = await repo.createBackup();
        backups.push(backupPath);
        // Small delay to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // List backups
      const existingBackups = await repo.listBackups();

      // Should have only 7 backups (oldest 3 should be deleted)
      assert.equal(existingBackups.length, 7, "Should keep only last 7 backups");

      // Verify first 3 backups were deleted
      for (let i = 0; i < 3; i++) {
        const exists = await fs.access(backups[i]).then(() => true).catch(() => false);
        assert.equal(exists, false, `Backup ${i} should have been deleted`);
      }

      // Verify last 7 backups exist
      for (let i = 3; i < 10; i++) {
        const exists = await fs.access(backups[i]).then(() => true).catch(() => false);
        assert.ok(exists, `Backup ${i} should still exist`);
      }
    });
  });

  describe("restoreFromBackup", () => {
    it("restores data from backup successfully", async () => {
      // Add initial data
      const stock: CreateStockRecord = {
        symbol: "ORIGINAL",
        name: "Original Stock",
        createdAt: new Date(),
      };
      await repo.createStock(stock);

      const trade: CreateTradeRecord = {
        id: "test-trade-orig",
        symbol: "ORIGINAL",
        side: "BUY",
        quantity: 10,
        price: 100,
        executedAt: new Date(),
      };
      await repo.createTrade(trade);

      // Create backup
      const backupPath = await repo.createBackup();

      // Modify data
      const newStock: CreateStockRecord = {
        symbol: "MODIFIED",
        name: "Modified Stock",
        createdAt: new Date(),
      };
      await repo.createStock(newStock);

      // Verify modified state
      const beforeRestore = await repo.listStocks();
      assert.equal(beforeRestore.length, 2, "Should have 2 stocks before restore");

      // Restore from backup
      await repo.restoreFromBackup(backupPath);

      // Verify restored state
      const afterRestore = await repo.listStocks();
      assert.equal(afterRestore.length, 1, "Should have 1 stock after restore");
      assert.equal(afterRestore[0].symbol, "ORIGINAL", "Should have original stock");

      const trades = await repo.listTrades();
      assert.equal(trades.length, 1, "Should have 1 trade after restore");
    });

    it("throws error when backup does not exist", async () => {
      const fakePath = path.join(testDir, "non-existent-backup");

      await assert.rejects(
        async () => repo.restoreFromBackup(fakePath),
        /Backup not found/,
        "Should throw error for non-existent backup"
      );
    });

    it("reinitializes database after restore", async () => {
      // Add data and create backup
      const stock: CreateStockRecord = {
        symbol: "TEST",
        name: "Test Stock",
        createdAt: new Date(),
      };
      await repo.createStock(stock);

      const backupPath = await repo.createBackup();

      // Restore
      await repo.restoreFromBackup(backupPath);

      // Verify we can still use the database
      const newStock: CreateStockRecord = {
        symbol: "NEW",
        name: "New Stock",
        createdAt: new Date(),
      };
      await repo.createStock(newStock);

      const stocks = await repo.listStocks();
      assert.equal(stocks.length, 2, "Should be able to add data after restore");
    });
  });

  describe("listBackups", () => {
    it("returns empty array when no backups exist", async () => {
      const backups = await repo.listBackups();
      assert.deepEqual(backups, [], "Should return empty array when no backups exist");
    });

    it("lists all backups sorted by date (newest first)", async () => {
      // Create 3 backups
      const backup1 = await repo.createBackup();
      await new Promise(resolve => setTimeout(resolve, 1100));

      const backup2 = await repo.createBackup();
      await new Promise(resolve => setTimeout(resolve, 1100));

      const backup3 = await repo.createBackup();

      const backups = await repo.listBackups();

      assert.equal(backups.length, 3, "Should list all 3 backups");

      // Verify order (newest first)
      assert.equal(backups[0], backup3, "Newest backup should be first");
      assert.equal(backups[1], backup2, "Second newest should be second");
      assert.equal(backups[2], backup1, "Oldest should be last");
    });

    it("only lists backup directories, not other files", async () => {
      // Create a backup
      await repo.createBackup();

      // Create a random file in backups directory
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const backupDir = path.join(path.dirname((repo as any).storePath), '../backups');
      const randomFilePath = path.join(backupDir, "random-file.txt");
      await fs.writeFile(randomFilePath, "test");

      const backups = await repo.listBackups();

      // Should only have 1 backup (not the random file)
      assert.equal(backups.length, 1, "Should only list backup directories");
      assert.ok(backups[0].includes("portfolio-"), "Should list portfolio backup");
    });
  });

  describe("getStats", () => {
    it("includes backup information in stats", async () => {
      // Add some data
      const stock: CreateStockRecord = {
        symbol: "TEST",
        name: "Test Stock",
        createdAt: new Date(),
      };
      await repo.createStock(stock);

      // Create backups
      await repo.createBackup();
      await new Promise(resolve => setTimeout(resolve, 1100));
      await repo.createBackup();

      const stats = await repo.getStats();

      assert.ok("backupCount" in stats, "Stats should include backup count");
      assert.equal(stats.backupCount, 2, "Should show 2 backups");
      assert.ok("lastBackup" in stats, "Stats should include last backup time");
    });
  });

  describe("exportToJson", () => {
    it("exports all data to JSON format", async () => {
      // Add test data
      const stock: CreateStockRecord = {
        symbol: "EXPORT",
        name: "Export Test",
        createdAt: new Date(),
      };
      await repo.createStock(stock);

      const trade: CreateTradeRecord = {
        id: "test-trade-export",
        symbol: "EXPORT",
        side: "BUY",
        quantity: 5,
        price: 50,
        executedAt: new Date(),
      };
      await repo.createTrade(trade);

      const jsonData = await repo.exportToJson();

      assert.ok("stocks" in jsonData, "Export should include stocks");
      assert.ok("trades" in jsonData, "Export should include trades");
      assert.ok("exportedAt" in jsonData, "Export should include timestamp");

      const data = jsonData as { stocks: Array<unknown>; trades: Array<unknown> };
      assert.equal(data.stocks.length, 1, "Should export 1 stock");
      assert.equal(data.trades.length, 1, "Should export 1 trade");
    });
  });
});
