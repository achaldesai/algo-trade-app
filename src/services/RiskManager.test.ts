import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import { RiskManager, type RiskLimits } from "./RiskManager";
import type { SettingsRepo } from "../db/repositories/SettingsRepo";
import type { BrokerOrderRequest } from "../types";

describe("RiskManager", () => {
    let riskManager: RiskManager;
    let mockSettingsRepo: SettingsRepo;

    const defaultLimits: RiskLimits = {
        maxDailyLoss: 1000,
        maxDailyLossPercent: 2,
        maxPositionSize: 5000,
        maxOpenPositions: 3,
        stopLossPercent: 1.5,
    };

    beforeEach(() => {
        mockSettingsRepo = {
            getRiskLimits: () => ({ ...defaultLimits }),
            on: mock.fn(),
            saveRiskLimits: mock.fn(() => Promise.resolve()),
            resetToDefaults: mock.fn(),
        } as unknown as SettingsRepo;

        riskManager = new RiskManager(mockSettingsRepo);
    });

    describe("checkOrderAllowed", () => {
        it("should allow valid orders", () => {
            const order: BrokerOrderRequest = {
                symbol: "TEST",
                side: "BUY",
                quantity: 10,
                type: "LIMIT",
                price: 100,
                tag: "test",
            };

            const result = riskManager.checkOrderAllowed("test-user", order, 0, 0);
            assert.strictEqual(result.allowed, true);
        });

        it("should reject orders with invalid quantity", () => {
            const order: BrokerOrderRequest = {
                symbol: "TEST",
                side: "BUY",
                quantity: 0,
                type: "MARKET",
                tag: "test",
            };

            const result = riskManager.checkOrderAllowed("test-user", order, 0, 0);
            assert.strictEqual(result.allowed, false);
            assert.ok(result.reason?.includes("Invalid quantity"));
        });

        it("should reject orders exceeding max position size", () => {
            const order: BrokerOrderRequest = {
                symbol: "TEST",
                side: "BUY",
                quantity: 100,
                type: "LIMIT",
                price: 100,
                tag: "test",
            };

            const result = riskManager.checkOrderAllowed("test-user", order, 0, 0);
            assert.strictEqual(result.allowed, false);
            assert.ok(result.reason?.includes("exceeds max position size"));
        });

        it("should reject MARKET orders with no reference price (non-emergency)", () => {
            const orderNoPrice: BrokerOrderRequest = {
                symbol: "TEST",
                side: "BUY",
                quantity: 10,
                type: "MARKET",
                tag: "test",
            };

            const resultNoPrice = riskManager.checkOrderAllowed("test-user", orderNoPrice, 0, 0);
            assert.strictEqual(resultNoPrice.allowed, false);
            assert.ok(resultNoPrice.reason?.includes("missing reference price"));

            const orderZeroPrice: BrokerOrderRequest = {
                symbol: "TEST",
                side: "BUY",
                quantity: 10,
                type: "MARKET",
                price: 0,
                tag: "test",
            };

            const resultZeroPrice = riskManager.checkOrderAllowed("test-user", orderZeroPrice, 0, 0);
            assert.strictEqual(resultZeroPrice.allowed, false);
            assert.ok(resultZeroPrice.reason?.includes("missing reference price"));
        });

        it("should reject MARKET orders whose value exceeds max position size", () => {
            const order: BrokerOrderRequest = {
                symbol: "TEST",
                side: "BUY",
                quantity: 100,
                type: "MARKET",
                price: 100,
                tag: "test",
            };

            const result = riskManager.checkOrderAllowed("test-user", order, 0, 0);
            assert.strictEqual(result.allowed, false);
            assert.ok(result.reason?.includes("exceeds max position size"));
        });

        it("should reject a BUY that pushes the symbol past the per-symbol cap", () => {
            const cappedSettings = {
                getRiskLimits: () => ({ ...defaultLimits, maxPositionSizePerSymbol: 1000 }),
                on: mock.fn(),
                saveRiskLimits: mock.fn(() => Promise.resolve()),
            } as unknown as SettingsRepo;
            const cappedRiskManager = new RiskManager(cappedSettings);

            const order: BrokerOrderRequest = {
                symbol: "TEST",
                side: "BUY",
                quantity: 10,
                type: "MARKET",
                price: 100,
                tag: "test",
            };

            const result = cappedRiskManager.checkOrderAllowed("test-user", order, 0, 0, 800);
            assert.strictEqual(result.allowed, false);
            assert.ok(result.reason?.includes("exceeds per-symbol cap"));
        });

        it("should allow a SELL that reduces the symbol even when current notional exceeds the cap", () => {
            const cappedSettings = {
                getRiskLimits: () => ({ ...defaultLimits, maxPositionSizePerSymbol: 1000 }),
                on: mock.fn(),
                saveRiskLimits: mock.fn(() => Promise.resolve()),
            } as unknown as SettingsRepo;
            const cappedRiskManager = new RiskManager(cappedSettings);

            const order: BrokerOrderRequest = {
                symbol: "TEST",
                side: "SELL",
                quantity: 10,
                type: "MARKET",
                price: 100,
                tag: "test",
            };

            const result = cappedRiskManager.checkOrderAllowed("test-user", order, 0, 0, 2000);
            assert.strictEqual(result.allowed, true);
        });

        it("should allow reducing a long even when the order value exceeds max position size", () => {
            const order: BrokerOrderRequest = {
                symbol: "TEST",
                side: "SELL",
                quantity: 1000,
                type: "MARKET",
                price: 150,
                tag: "test",
            };

            const result = riskManager.checkOrderAllowed("test-user", order, 0, 0, 150000);
            assert.strictEqual(result.allowed, true);
        });

        it("should cap opening a short when the order value exceeds max position size", () => {
            const order: BrokerOrderRequest = {
                symbol: "TEST",
                side: "SELL",
                quantity: 100,
                type: "MARKET",
                price: 100,
                tag: "test",
            };

            const result = riskManager.checkOrderAllowed("test-user", order, 0, 0, 0);
            assert.strictEqual(result.allowed, false);
            assert.ok(result.reason?.includes("exceeds max position size"));
        });

        it("should allow covering a short even when the order value exceeds max position size", () => {
            const order: BrokerOrderRequest = {
                symbol: "TEST",
                side: "BUY",
                quantity: 1000,
                type: "MARKET",
                price: 150,
                tag: "test",
            };

            const result = riskManager.checkOrderAllowed("test-user", order, 0, 0, -50000);
            assert.strictEqual(result.allowed, true);
        });

        it("should allow emergency MARKET orders with price 0", () => {
            const order: BrokerOrderRequest = {
                symbol: "TEST",
                side: "SELL",
                quantity: 10,
                type: "MARKET",
                price: 0,
                tag: "PANIC-SELL-123",
            };

            const result = riskManager.checkOrderAllowed("test-user", order, 0, 0);
            assert.strictEqual(result.allowed, true);
        });

        it("should reject new positions when max open positions reached", () => {
            const order: BrokerOrderRequest = {
                symbol: "TEST",
                side: "BUY",
                quantity: 10,
                type: "LIMIT",
                price: 100,
                tag: "test",
            };

            const result = riskManager.checkOrderAllowed("test-user", order, 0, 3);
            assert.strictEqual(result.allowed, false);
            assert.ok(result.reason?.includes("Max open positions limit reached"));
        });

        it("should allow closing trades even if max positions reached", () => {
            const order: BrokerOrderRequest = {
                symbol: "TEST",
                side: "SELL",
                quantity: 10,
                type: "LIMIT",
                price: 105,
                tag: "test",
            };

            const result = riskManager.checkOrderAllowed("test-user", order, 0, 3);
            assert.strictEqual(result.allowed, true);
        });

        it("should reject orders if daily loss limit exceeded", async () => {
            const order: BrokerOrderRequest = {
                symbol: "TEST",
                side: "BUY",
                quantity: 10,
                type: "LIMIT",
                price: 100,
                tag: "test",
            };

            await riskManager.updatePnL("test-user", -900, 0);

            const result = riskManager.checkOrderAllowed("test-user", order, -200, 0);
            assert.strictEqual(result.allowed, false);
            assert.ok(result.reason?.includes("Daily loss limit exceeded"));
        });

        it("should reject orders if circuit breaker is triggered", async () => {
            const order: BrokerOrderRequest = {
                symbol: "TEST",
                side: "BUY",
                quantity: 10,
                type: "LIMIT",
                price: 100,
                tag: "test",
            };

            await riskManager.updatePnL("test-user", -1500, 0);

            assert.strictEqual(riskManager.isCircuitBroken("test-user"), true);

            const result = riskManager.checkOrderAllowed("test-user", order, 0, 0);
            assert.strictEqual(result.allowed, false);
            assert.ok(result.reason?.includes("Circuit breaker active"));
        });
    });

    describe("updatePnL", () => {
        it("should trigger circuit breaker when loss limit hit", async () => {
            let circuitEventTriggered = false;
            riskManager.on("circuit_break", () => {
                circuitEventTriggered = true;
            });

            await riskManager.updatePnL("test-user", -1001, 0);

            assert.strictEqual(riskManager.isCircuitBroken("test-user"), true);
            assert.strictEqual(circuitEventTriggered, true);
        });
    });
});
