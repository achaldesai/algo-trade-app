import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "events";
import { StopLossMonitor } from "./StopLossMonitor";
import type { StopLossConfig, StopLossRepository } from "../persistence/StopLossRepository";
import type MarketDataService from "./MarketDataService";
import type TradingEngine from "./TradingEngine";
import type { RiskManager } from "./RiskManager";
import type { MarketTick, Trade } from "../types";

// Mock implementations
class MockMarketDataService extends EventEmitter {
    emitTick(tick: MarketTick) {
        this.emit("tick", tick);
    }
}

class MockTradingEngine extends EventEmitter {
    activeBroker = {
        name: "MockBroker",
        isConnected: () => true,
        connect: async () => { },
        placeOrder: async (order: unknown) => ({
            id: "mock-exec-1",
            request: order,
            status: "FILLED",
            filledQuantity: (order as { quantity: number }).quantity,
            averagePrice: 95,
            executedAt: new Date(),
        }),
    };

    getActiveBroker() {
        return this.activeBroker;
    }

    async executeSignal(_broker: unknown, signal: unknown) {
        return {
            signal,
            executions: [
                {
                    id: "mock-exec-1",
                    request: {},
                    status: "FILLED",
                    filledQuantity: 10,
                    averagePrice: 95,
                    executedAt: new Date(),
                },
            ],
            failures: [],
        };
    }

    emitTrade(trade: Trade) {
        this.emit("trade-executed", trade);
    }
}

class MockStopLossRepository extends EventEmitter implements StopLossRepository {
    private configs = new Map<string, StopLossConfig>();

    async initialize() { }

    getAll(): StopLossConfig[] {
        return Array.from(this.configs.values());
    }

    get(symbol: string): StopLossConfig | undefined {
        return this.configs.get(symbol.toUpperCase());
    }

    async save(config: StopLossConfig) {
        this.configs.set(config.symbol.toUpperCase(), config);
        this.emit("saved", config);
    }

    async delete(symbol: string) {
        this.configs.delete(symbol.toUpperCase());
        this.emit("deleted", symbol);
    }

    async close() { }
}

class MockRiskManager {
    getStatus() {
        return {
            circuitBroken: false,
            dailyPnL: 0,
            limits: {
                maxDailyLoss: 5000,
                maxDailyLossPercent: 2,
                maxPositionSize: 100000,
                maxOpenPositions: 5,
                stopLossPercent: 3,
            },
        };
    }
}

describe("StopLossMonitor", () => {
    let monitor: StopLossMonitor;
    let mockMarketData: MockMarketDataService;
    let mockTradingEngine: MockTradingEngine;
    let mockRepository: MockStopLossRepository;
    let mockRiskManager: MockRiskManager;

    beforeEach(() => {
        mockMarketData = new MockMarketDataService();
        mockTradingEngine = new MockTradingEngine();
        mockRepository = new MockStopLossRepository();
        mockRiskManager = new MockRiskManager();

        monitor = new StopLossMonitor({
            marketDataService: mockMarketData as unknown as MarketDataService,
            tradingEngine: mockTradingEngine as unknown as TradingEngine,
            stopLossRepository: mockRepository,
            riskManager: mockRiskManager as unknown as RiskManager,
        });
    });

    afterEach(() => {
        monitor.stop();
    });

    describe("start/stop", () => {
        it("should start monitoring", () => {
            monitor.start();
            assert.strictEqual(monitor.isRunning(), true);
        });

        it("should stop monitoring", () => {
            monitor.start();
            monitor.stop();
            assert.strictEqual(monitor.isRunning(), false);
        });
    });

    describe("setStopLoss", () => {
        it("should create a fixed stop-loss at default 3%", async () => {
            const config = await monitor.setStopLoss("RELIANCE", {
                entryPrice: 100,
                quantity: 10,
            });

            assert.strictEqual(config.symbol, "RELIANCE");
            assert.strictEqual(config.entryPrice, 100);
            assert.strictEqual(config.stopLossPrice, 97); // 100 - 3%
            assert.strictEqual(config.quantity, 10);
            assert.strictEqual(config.type, "FIXED");
        });

        it("should create a trailing stop-loss", async () => {
            const config = await monitor.setStopLoss("TCS", {
                entryPrice: 200,
                quantity: 5,
                type: "TRAILING",
                trailingPercent: 5,
            });

            assert.strictEqual(config.type, "TRAILING");
            assert.strictEqual(config.trailingPercent, 5);
            // Initial stop-loss uses default 3% (stopLossPercent from RiskLimits)
            // unless stopLossPrice is explicitly provided
            assert.strictEqual(config.stopLossPrice, 194); // 200 - 3%
            assert.strictEqual(config.highWaterMark, 200);
        });

        it("should allow custom stop-loss price", async () => {
            const config = await monitor.setStopLoss("INFY", {
                entryPrice: 150,
                quantity: 20,
                stopLossPrice: 140,
            });

            assert.strictEqual(config.stopLossPrice, 140);
        });
    });

    describe("auto-create on trade", () => {
        it("should auto-create stop-loss on BUY trade", async () => {
            const trade: Trade = {
                id: "trade-1",
                symbol: "HDFC",
                side: "BUY",
                quantity: 10,
                price: 100,
                executedAt: new Date(),
            };

            mockTradingEngine.emitTrade(trade);

            // Wait for async handler
            await new Promise(resolve => setTimeout(resolve, 50));

            const stopLoss = monitor.get("HDFC");
            assert.ok(stopLoss, "Stop-loss should be created");
            assert.strictEqual(stopLoss.entryPrice, 100);
            assert.strictEqual(stopLoss.quantity, 10);
            assert.strictEqual(stopLoss.stopLossPrice, 97);
        });

        it("should update stop-loss on additional BUY trade", async () => {
            // First trade
            await monitor.setStopLoss("HDFC", {
                entryPrice: 100,
                quantity: 10,
            });

            const trade: Trade = {
                id: "trade-2",
                symbol: "HDFC",
                side: "BUY",
                quantity: 10,
                price: 110,
                executedAt: new Date(),
            };

            mockTradingEngine.emitTrade(trade);
            await new Promise(resolve => setTimeout(resolve, 50));

            const stopLoss = monitor.get("HDFC");
            assert.ok(stopLoss);
            assert.strictEqual(stopLoss.quantity, 20);
            // Average price: (100*10 + 110*10) / 20 = 105
            assert.strictEqual(stopLoss.entryPrice, 105);
        });

        it("should reduce quantity on SELL trade", async () => {
            await monitor.setStopLoss("RELIANCE", {
                entryPrice: 100,
                quantity: 20,
            });

            const trade: Trade = {
                id: "trade-3",
                symbol: "RELIANCE",
                side: "SELL",
                quantity: 5,
                price: 110,
                executedAt: new Date(),
            };

            mockTradingEngine.emitTrade(trade);
            await new Promise(resolve => setTimeout(resolve, 50));

            const stopLoss = monitor.get("RELIANCE");
            assert.ok(stopLoss);
            assert.strictEqual(stopLoss.quantity, 15);
        });

        it("should remove stop-loss when position fully closed", async () => {
            await monitor.setStopLoss("TCS", {
                entryPrice: 100,
                quantity: 10,
            });

            const trade: Trade = {
                id: "trade-4",
                symbol: "TCS",
                side: "SELL",
                quantity: 10,
                price: 120,
                executedAt: new Date(),
            };

            mockTradingEngine.emitTrade(trade);
            await new Promise(resolve => setTimeout(resolve, 50));

            const stopLoss = monitor.get("TCS");
            assert.strictEqual(stopLoss, undefined, "Stop-loss should be removed");
        });
    });

    describe("tick processing", () => {
        it("should trigger stop-loss when price breaches", async () => {
            monitor.start();

            await monitor.setStopLoss("INFY", {
                entryPrice: 100,
                quantity: 10,
            });

            let triggered = false;
            monitor.on("stop-loss-triggered", () => {
                triggered = true;
            });

            // Send tick below stop-loss (97)
            mockMarketData.emitTick({
                symbol: "INFY",
                price: 96,
                volume: 1000,
                timestamp: new Date(),
            });

            await new Promise(resolve => setTimeout(resolve, 100));

            assert.strictEqual(triggered, true, "Stop-loss should be triggered");
        });

        it("should NOT trigger stop-loss when price is above threshold", async () => {
            monitor.start();

            await monitor.setStopLoss("INFY", {
                entryPrice: 100,
                quantity: 10,
            });

            let triggered = false;
            monitor.on("stop-loss-triggered", () => {
                triggered = true;
            });

            // Send tick above stop-loss (97)
            mockMarketData.emitTick({
                symbol: "INFY",
                price: 98,
                volume: 1000,
                timestamp: new Date(),
            });

            await new Promise(resolve => setTimeout(resolve, 50));

            assert.strictEqual(triggered, false, "Stop-loss should NOT be triggered");
        });

        it("should update trailing stop on price increase", async () => {
            monitor.start();

            await monitor.setStopLoss("TCS", {
                entryPrice: 100,
                quantity: 5,
                type: "TRAILING",
                trailingPercent: 3,
            });

            // Initial stop-loss at 97
            let stopLoss = monitor.get("TCS");
            assert.strictEqual(stopLoss?.stopLossPrice, 97);

            // Price goes up to 110
            mockMarketData.emitTick({
                symbol: "TCS",
                price: 110,
                volume: 1000,
                timestamp: new Date(),
            });

            await new Promise(resolve => setTimeout(resolve, 50));

            // Stop-loss should trail up to 110 - 3% = 106.7
            stopLoss = monitor.get("TCS");
            assert.ok(stopLoss);
            assert.strictEqual(stopLoss.highWaterMark, 110);
            assert.ok(stopLoss.stopLossPrice > 106, `Stop-loss should be above 106, got ${stopLoss.stopLossPrice}`);
        });
    });

    describe("getStatus", () => {
        it("should return correct status", async () => {
            await monitor.setStopLoss("A", { entryPrice: 100, quantity: 10 });
            await monitor.setStopLoss("B", { entryPrice: 200, quantity: 5 });

            const status = monitor.getStatus();

            assert.strictEqual(status.monitoring, false);
            assert.strictEqual(status.activeStopLosses, 2);
            assert.strictEqual(status.stopLosses.length, 2);
        });
    });
    describe("race conditions and edge cases", () => {
        it("should prevent double execution for the same symbol", async () => {
            monitor.start();
            await monitor.setStopLoss("WIPRO", {
                entryPrice: 400,
                quantity: 100,
            });

            // Mock executeSignal to be slow to simulate concurrency window
            // We need to override the mock method for this specific test or rely on the fact 
            // that 'await' in handleTick yields control.

            let executionCount = 0;
            monitor.on("stop-loss-executed", () => executionCount++);

            // Send two ticks rapidly that both breach stop loss (3% of 400 = 12 -> stop 388)
            const tick1 = { symbol: "WIPRO", price: 380, volume: 100, timestamp: new Date() };
            const tick2 = { symbol: "WIPRO", price: 379, volume: 100, timestamp: new Date() };

            // Emit concurrently without awaiting individually
            const p1 = (monitor as unknown as { handleTick: (t: MarketTick) => Promise<void> }).handleTick(tick1);
            const p2 = (monitor as unknown as { handleTick: (t: MarketTick) => Promise<void> }).handleTick(tick2);

            await Promise.all([p1, p2]);

            // One should succeed, one might be skipped or both processed if lock fails
            // With lock, only ONE execution should happen effectively because 
            // the first one will remove the stop loss configuration.
            // OR, the second one will return early because of processingSymbols check.

            // Wait for all async ops to settle
            await new Promise(resolve => setTimeout(resolve, 100));

            assert.strictEqual(executionCount, 1, "Should execute stop-loss exactly once");
        });

        it("should process stop-loss trigger even after trailing stop update in same tick", async () => {
            // Scenario: Trailing stop trails UP, but then price crashes in the SAME tick? 
            // Actually, a single tick has only one price. 
            // The scenario is: Previous HighWaterMark was X. Current Price is Y > X. 
            // Update HWM to Y. New Stop Loss is Y - %. 
            // If Y is somehow causing a breach? No, if price goes UP, it won't breach a trailing stop (which is below).
            // BUT, what if we have a weird logic where we updated HWM but the calculated SL is still breached?
            // (Only possible if trailing% is huge or price jumped weirdly? Unlikely).

            // Real Scenario: We receive a tick that triggers a trailing update.
            // THEN immediately another tick comes that crashes.
            // OR the code logic that refreshed config handles it.

            // Let's test the "Refresh Config" logic specifically. 
            // We can simulate this by mocking repository.save to imply update happened.
            // But let's test simpler: ensure updateTrailingStop -> save -> subsequent check sees new SL.

            monitor.start();
            await monitor.setStopLoss("SBI", {
                entryPrice: 500,
                quantity: 10,
                type: "TRAILING",
                trailingPercent: 10 // Wide trail
            });
            // SL @ 450. HWM @ 500.

            // Tick 1: Price 550.
            // Trails HWM to 550. New New SL = 550 - 10% = 495.
            // This tick itself (550) is > 495, so no breach.

            await (monitor as unknown as { handleTick: (t: MarketTick) => Promise<void> }).handleTick({ symbol: "SBI", price: 550, volume: 10, timestamp: new Date() });

            const sl = monitor.get("SBI");
            assert.strictEqual(sl?.stopLossPrice, 495);

            // Now test the specific code path: "updateTrailingStop" is called, then check.
            // If we somehow had a tick that Updated Trailing BUT ALSO Breached?
            // Impossible mathematically if Update condition is Price > HWM (since SL < HWM).
            // So we just verify the Update logic works.

            // However, let's verify that lock is released properly so subsequent tick works.
            await (monitor as unknown as { handleTick: (t: MarketTick) => Promise<void> }).handleTick({ symbol: "SBI", price: 400, volume: 10, timestamp: new Date() });

            await new Promise(resolve => setTimeout(resolve, 50));
            assert.strictEqual(monitor.get("SBI"), undefined, "Should be sold");
        });
    });
});
