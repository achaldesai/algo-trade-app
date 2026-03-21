import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "events";
import { StopLossMonitor } from "./StopLossMonitor";
import type { StopLossConfig } from "../db/repositories/StopLossRepo";
import type { StopLossRepo } from "../db/repositories/StopLossRepo";
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

    async executeSignal(_userId: string, _broker: unknown, signal: unknown) {
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

    emitTrade(trade: Trade, userId = "test-user") {
        this.emit("trade-executed", { trade, userId });
    }
}

class MockStopLossRepository extends EventEmitter {
    private configs = new Map<string, StopLossConfig>();

    getBySymbol(symbol: string): StopLossConfig[] {
        return Array.from(this.configs.values()).filter((c: StopLossConfig) => c.symbol === symbol.toUpperCase());
    }

    getAll(userId?: string): StopLossConfig[] {
        if (userId) {
            return Array.from(this.configs.values()).filter((c: StopLossConfig) => c.userId === userId);
        }
        return Array.from(this.configs.values());
    }

    get(userId: string, symbol: string): StopLossConfig | undefined {
        return this.configs.get(`${userId}:${symbol.toUpperCase()}`);
    }

    async save(config: StopLossConfig) {
        this.configs.set(`${config.userId}:${config.symbol.toUpperCase()}`, config);
        this.emit("saved", config);
    }

    async delete(userId: string, symbol: string) {
        this.configs.delete(`${userId}:${symbol.toUpperCase()}`);
        this.emit("deleted", symbol);
    }
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
            stopLossRepository: mockRepository as unknown as StopLossRepo,
            riskManager: mockRiskManager as unknown as RiskManager,
            brokerFactory: async () => mockTradingEngine.activeBroker as unknown as import("../brokers/BrokerClient").default,
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
            const config = await monitor.setStopLoss("test-user", "RELIANCE", {
                entryPrice: 100,
                quantity: 10,
            });

            assert.strictEqual(config.symbol, "RELIANCE");
            assert.strictEqual(config.entryPrice, 100);
            assert.strictEqual(config.stopLossPrice, 97);
            assert.strictEqual(config.quantity, 10);
            assert.strictEqual(config.type, "FIXED");
        });

        it("should create a trailing stop-loss", async () => {
            const config = await monitor.setStopLoss("test-user", "TCS", {
                entryPrice: 200,
                quantity: 5,
                type: "TRAILING",
                trailingPercent: 5,
            });

            assert.strictEqual(config.type, "TRAILING");
            assert.strictEqual(config.trailingPercent, 5);
            assert.strictEqual(config.stopLossPrice, 194);
            assert.strictEqual(config.highWaterMark, 200);
        });

        it("should allow custom stop-loss price", async () => {
            const config = await monitor.setStopLoss("test-user", "INFY", {
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
            await new Promise(resolve => setTimeout(resolve, 50));

            const stopLoss = monitor.get("test-user", "HDFC");
            assert.ok(stopLoss, "Stop-loss should be created");
            assert.strictEqual(stopLoss.entryPrice, 100);
            assert.strictEqual(stopLoss.quantity, 10);
            assert.strictEqual(stopLoss.stopLossPrice, 97);
        });

        it("should update stop-loss on additional BUY trade", async () => {
            await monitor.setStopLoss("test-user", "HDFC", {
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

            const stopLoss = monitor.get("test-user", "HDFC");
            assert.ok(stopLoss);
            assert.strictEqual(stopLoss.quantity, 20);
            assert.strictEqual(stopLoss.entryPrice, 105);
        });

        it("should reduce quantity on SELL trade", async () => {
            await monitor.setStopLoss("test-user", "RELIANCE", {
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

            const stopLoss = monitor.get("test-user", "RELIANCE");
            assert.ok(stopLoss);
            assert.strictEqual(stopLoss.quantity, 15);
        });

        it("should remove stop-loss when position fully closed", async () => {
            await monitor.setStopLoss("test-user", "TCS", {
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

            const stopLoss = monitor.get("test-user", "TCS");
            assert.strictEqual(stopLoss, undefined, "Stop-loss should be removed");
        });
    });

    describe("tick processing", () => {
        it("should trigger stop-loss when price breaches", async () => {
            monitor.start();

            await monitor.setStopLoss("test-user", "INFY", {
                entryPrice: 100,
                quantity: 10,
            });

            let triggered = false;
            monitor.on("stop-loss-triggered", () => {
                triggered = true;
            });

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

            await monitor.setStopLoss("test-user", "INFY", {
                entryPrice: 100,
                quantity: 10,
            });

            let triggered = false;
            monitor.on("stop-loss-triggered", () => {
                triggered = true;
            });

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

            await monitor.setStopLoss("test-user", "TCS", {
                entryPrice: 100,
                quantity: 5,
                type: "TRAILING",
                trailingPercent: 3,
            });

            let stopLoss = monitor.get("test-user", "TCS");
            assert.strictEqual(stopLoss?.stopLossPrice, 97);

            mockMarketData.emitTick({
                symbol: "TCS",
                price: 110,
                volume: 1000,
                timestamp: new Date(),
            });

            await new Promise(resolve => setTimeout(resolve, 50));

            stopLoss = monitor.get("test-user", "TCS");
            assert.ok(stopLoss);
            assert.strictEqual(stopLoss.highWaterMark, 110);
            assert.ok(stopLoss.stopLossPrice > 106, `Stop-loss should be above 106, got ${stopLoss.stopLossPrice}`);
        });
    });

    describe("getStatus", () => {
        it("should return correct status", async () => {
            await monitor.setStopLoss("test-user", "A", { entryPrice: 100, quantity: 10 });
            await monitor.setStopLoss("test-user", "B", { entryPrice: 200, quantity: 5 });

            const status = monitor.getStatus("test-user");

            assert.strictEqual(status.monitoring, false);
            assert.strictEqual(status.activeStopLosses, 2);
            assert.strictEqual(status.stopLosses.length, 2);
        });
    });

    describe("race conditions and edge cases", () => {
        it("should prevent double execution for the same symbol", async () => {
            monitor.start();
            await monitor.setStopLoss("test-user", "WIPRO", {
                entryPrice: 400,
                quantity: 100,
            });

            let executionCount = 0;
            monitor.on("stop-loss-executed", () => executionCount++);

            const tick1 = { symbol: "WIPRO", price: 380, volume: 100, timestamp: new Date() };
            const tick2 = { symbol: "WIPRO", price: 379, volume: 100, timestamp: new Date() };

            const p1 = (monitor as unknown as { handleTick: (t: MarketTick) => Promise<void> }).handleTick(tick1);
            const p2 = (monitor as unknown as { handleTick: (t: MarketTick) => Promise<void> }).handleTick(tick2);

            await Promise.all([p1, p2]);
            await new Promise(resolve => setTimeout(resolve, 100));

            assert.strictEqual(executionCount, 1, "Should execute stop-loss exactly once");
        });

        it("should process stop-loss trigger even after trailing stop update in same tick", async () => {
            monitor.start();
            await monitor.setStopLoss("test-user", "SBI", {
                entryPrice: 500,
                quantity: 10,
                type: "TRAILING",
                trailingPercent: 10,
            });

            await (monitor as unknown as { handleTick: (t: MarketTick) => Promise<void> }).handleTick({ symbol: "SBI", price: 550, volume: 10, timestamp: new Date() });

            const sl = monitor.get("test-user", "SBI");
            assert.strictEqual(sl?.stopLossPrice, 495);

            await (monitor as unknown as { handleTick: (t: MarketTick) => Promise<void> }).handleTick({ symbol: "SBI", price: 400, volume: 10, timestamp: new Date() });

            await new Promise(resolve => setTimeout(resolve, 50));
            assert.strictEqual(monitor.get("test-user", "SBI"), undefined, "Should be sold");
        });
    });
});
