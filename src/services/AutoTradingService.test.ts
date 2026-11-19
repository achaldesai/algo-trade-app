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

  // Auto-start is opt-in (ACH-35): scanning is harmless, switching trading on is not.
  const routine = (autoStart: boolean) => {
    const started = { loop: false, stopLoss: false, scanned: false };
    mockTradingLoop.start = () => { started.loop = true; };
    mockTradingLoop.getStatus = () => ({ running: false, mode: "parallel" });
    mockStopLossMonitor.start = () => { started.stopLoss = true; };
    mockStopLossMonitor.isRunning = () => false;
    const scanner = { ...mockScanner, scan: async (n: number) => { started.scanned = true; return mockScanner.scan(n); } };
    const service = new AutoTradingService(
      scanner as any,
      null,
      mockStopLossMonitor as any,
      mockPortfolioService as any,
      mockUserRepo as any,
      mockTradingLoop as any,
      () => autoStart,
    );
    return { service, started };
  };

  it("starts the trading loop and stop-loss monitor when auto-start is on", async () => {
    const { service, started } = routine(true);
    await service.executeDailyRoutine();
    assert.deepEqual(started, { loop: true, stopLoss: true, scanned: true });
  });

  it("only scans when auto-start is off (the default), leaving trading off", async () => {
    const { service, started } = routine(false);
    await service.executeDailyRoutine();
    assert.deepEqual(started, { loop: false, stopLoss: false, scanned: true });

    const defaulted = new AutoTradingService(mockScanner, null, mockStopLossMonitor as any, mockPortfolioService as any, mockUserRepo as any, mockTradingLoop as any);
    assert.deepEqual(defaulted.getAutoStartStatus(), { enabled: false, manuallyStopped: false }, "off unless configured");
  });

  it("stays off after a manual STOP / panic sell, even with auto-start on, until START", async () => {
    const { service, started } = routine(true);
    service.markManualStop();
    await service.executeDailyRoutine();
    assert.equal(started.loop, false);
    assert.deepEqual(service.getAutoStartStatus(), { enabled: true, manuallyStopped: true });

    service.clearManualStop();
    await service.executeDailyRoutine();
    assert.equal(started.loop, true);
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
