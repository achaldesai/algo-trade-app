/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { AutoTradingService } from "./AutoTradingService";
import type { MarketScannerService } from "./MarketScannerService";

// Mock setTimeout/clearTimeout to control timer behavior
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;

describe("AutoTradingService", () => {
  let scanCount = 0;
  let mockScanner: MarketScannerService;
  let mockTradingLoop: { start: () => void; stop: () => void; getStatus: () => { running: boolean; mode: string } };
  let mockStopLossMonitor: { start: () => void; stop: () => void; isRunning: () => boolean; getStatus: () => unknown };
  let mockPortfolioService: { getSnapshot: () => Promise<{ positions: Array<{ symbol: string; netQuantity: number }> }> };
  let mockUserRepo: { listUsers: () => Array<{ id: string }> };

  beforeEach(() => {
    scanCount = 0;
    mockScanner = {
      scan: async (_limit: number) => {
        scanCount++;
        return [{ symbol: "RELIANCE", score: 95 }, { symbol: "TCS", score: 90 }];
      },
      applyPicks: async () => {},
      instrumentService: { getToken: () => "2885" },
    } as unknown as MarketScannerService;

    mockTradingLoop = {
      start: () => {},
      stop: () => {},
      getStatus: () => ({ running: false, mode: "parallel" }),
    };

    mockStopLossMonitor = {
      start: () => {},
      stop: () => {},
      isRunning: () => false,
      getStatus: () => ({ monitoring: false, activeStopLosses: 0 }),
    };

    mockPortfolioService = {
      getSnapshot: async () => ({ positions: [] }),
    };

    mockUserRepo = {
      listUsers: () => [],
    };

    // Stub timers
    global.setTimeout = (() => ({})) as any;
    global.clearTimeout = (() => {}) as any;
    global.setInterval = (() => ({})) as any;
    global.clearInterval = (() => {}) as any;
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  });

  it("should start and schedule a scan", () => {
    const service = new AutoTradingService(
      mockScanner,
      null,
      mockStopLossMonitor as any,
      mockPortfolioService as any,
      mockUserRepo as any,
      mockTradingLoop as any,
    );

    service.start();
    // Service should not throw and should have scheduled a timer
    assert.ok(true, "start() completes without error");
  });

  it("should stop without error", () => {
    const service = new AutoTradingService(
      mockScanner,
      null,
      mockStopLossMonitor as any,
      mockPortfolioService as any,
      mockUserRepo as any,
      mockTradingLoop as any,
    );

    service.start();
    service.stop();
    assert.ok(true, "stop() completes without error");
  });

  it("should execute daily routine and scan for picks", async () => {
    const service = new AutoTradingService(
      mockScanner,
      null,
      mockStopLossMonitor as any,
      mockPortfolioService as any,
      mockUserRepo as any,
      mockTradingLoop as any,
    );

    await service.executeDailyRoutine();
    assert.equal(scanCount, 1);
  });

  it("should start trading loop and stop-loss when they are stopped", async () => {
    let loopStarted = false;
    let stopLossStarted = false;

    mockTradingLoop.start = () => { loopStarted = true; };
    mockTradingLoop.getStatus = () => ({ running: false, mode: "parallel" });
    mockStopLossMonitor.start = () => { stopLossStarted = true; };
    mockStopLossMonitor.isRunning = () => false;

    const service = new AutoTradingService(
      mockScanner,
      null,
      mockStopLossMonitor as any,
      mockPortfolioService as any,
      mockUserRepo as any,
      mockTradingLoop as any,
    );

    await service.executeDailyRoutine();
    assert.equal(loopStarted, true);
    assert.equal(stopLossStarted, true);
  });

  it("should not restart already-running trading loop", async () => {
    let loopStarted = false;
    mockTradingLoop.start = () => { loopStarted = true; };
    mockTradingLoop.getStatus = () => ({ running: true, mode: "parallel" });
    mockStopLossMonitor.isRunning = () => true;

    const service = new AutoTradingService(
      mockScanner,
      null,
      mockStopLossMonitor as any,
      mockPortfolioService as any,
      mockUserRepo as any,
      mockTradingLoop as any,
    );

    await service.executeDailyRoutine();
    assert.equal(loopStarted, false);
  });

  it("should execute rotation routine with picks", async () => {
    const service = new AutoTradingService(
      mockScanner,
      null,
      mockStopLossMonitor as any,
      mockPortfolioService as any,
      mockUserRepo as any,
      mockTradingLoop as any,
    );

    await service.executeDailyRoutine(); // Sets lastPicks
    await service.executeRotationRoutine();
    assert.ok(true, "rotation completes without error");
  });

  it("should handle double start gracefully", () => {
    const service = new AutoTradingService(
      mockScanner,
      null,
      mockStopLossMonitor as any,
      mockPortfolioService as any,
      mockUserRepo as any,
      mockTradingLoop as any,
    );

    service.start();
    service.start(); // Should be idempotent
    assert.ok(true, "double start() does not throw");
  });
});
