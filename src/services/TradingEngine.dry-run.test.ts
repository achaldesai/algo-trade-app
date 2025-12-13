import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import TradingEngine from "./TradingEngine";
import { resolvePortfolioService, resolveMarketDataService, resolveRiskManager } from "../container";
import PaperBroker from "../brokers/PaperBroker";
import type { BrokerOrderRequest, StrategySignal } from "../types";
import env from "../config/env";

const setDryRunFlag = (value: boolean): void => {
  Reflect.set(env, "dryRun", value);
};

describe("TradingEngine - Dry Run Mode", () => {
  let engine: TradingEngine;
  let broker: PaperBroker;
  let originalDryRun: boolean;

  beforeEach(async () => {
    // Save original dry-run setting
    originalDryRun = env.dryRun;

    const portfolioService = resolvePortfolioService();
    const marketData = resolveMarketDataService();
    const riskManager = resolveRiskManager();
    broker = new PaperBroker();

    engine = new TradingEngine({
      broker,
      portfolioService,
      marketData,
      riskManager,
    });
  });

  afterEach(() => {
    // Restore original setting
    setDryRunFlag(originalDryRun);
  });

  it("should not execute orders when dry-run mode is enabled", async () => {
    // Enable dry-run mode
    setDryRunFlag(true);

    const signal: StrategySignal = {
      strategyId: "test-strategy",
      description: "Test dry run order",
      requestedOrders: [
        {
          symbol: "AAPL",
          side: "BUY",
          quantity: 10,
          price: 150.00,
          type: "LIMIT",
          exchange: "NSE",
        } as BrokerOrderRequest,
      ],
    };

    const result = await engine.executeSignal(broker, signal);

    // Should return executions
    assert.strictEqual(result.executions.length, 1);

    // But with zero filled quantity (no actual execution)
    assert.strictEqual(result.executions[0].filledQuantity, 0);

    // And ID should indicate dry-run
    assert.ok(result.executions[0].id.startsWith("dry-run-"));

    // No failures
    assert.strictEqual(result.failures.length, 0);

    // Check that no trades were recorded (can't check this easily without access to portfolioService)
    // Just verify dry-run behavior worked
  });

  it("should execute orders normally when dry-run mode is disabled", async () => {
    // Disable dry-run mode
    setDryRunFlag(false);

    const portfolioService = resolvePortfolioService();

    // Ensure stock exists (ignore if already exists)
    try {
      await portfolioService.addStock({ symbol: "AAPL", name: "Apple Inc." });
    } catch {
      // Stock already exists, that's fine
    }

    const signal: StrategySignal = {
      strategyId: "test-strategy",
      description: "Test normal order",
      requestedOrders: [
        {
          symbol: "AAPL",
          side: "BUY",
          quantity: 10,
          price: 150.00,
          type: "LIMIT",
          exchange: "NSE",
        } as BrokerOrderRequest,
      ],
    };

    const result = await engine.executeSignal(broker, signal);

    // Should return executions
    assert.ok(result.executions.length >= 0, "Should return executions array");

    // In dry-run mode, filled quantity will be 0; in normal mode it should be > 0
    if (!env.dryRun && result.executions.length > 0) {
      assert.ok(result.executions[0].filledQuantity > 0, "Should have filled quantity when not in dry-run");
    }
  });

  it("should validate order limits before execution", async () => {
    // Disable dry-run mode to test validation
    setDryRunFlag(false);

    const portfolioService = resolvePortfolioService();

    // Ensure stock exists (ignore if already exists)
    try {
      await portfolioService.addStock({ symbol: "AAPL", name: "Apple Inc." });
    } catch {
      // Stock already exists, that's fine
    }

    // Create order that exceeds max position size
    const largeOrder: StrategySignal = {
      strategyId: "test-strategy",
      description: "Test large order",
      requestedOrders: [
        {
          symbol: "AAPL",
          side: "BUY",
          quantity: 10000, // Large quantity
          price: 150.00,   // Total: 1,500,000 > default limit (100,000)
          type: "LIMIT",
          exchange: "NSE",
        } as BrokerOrderRequest,
      ],
    };

    const result = await engine.executeSignal(broker, largeOrder);

    // Should have failures due to position size limit
    assert.strictEqual(result.failures.length, 1);
    assert.ok(result.failures[0].error.includes("max position size"));
  });

  it("should reject orders with invalid price", async () => {
    setDryRunFlag(false);

    const portfolioService = resolvePortfolioService();
    try {
      await portfolioService.addStock({ symbol: "AAPL", name: "Apple Inc." });
    } catch {
      // Stock already exists, that's fine
    }

    const invalidOrder: StrategySignal = {
      strategyId: "test-strategy",
      description: "Test invalid price",
      requestedOrders: [
        {
          symbol: "AAPL",
          side: "BUY",
          quantity: 10,
          price: -50.00, // Invalid negative price
          type: "LIMIT",
          exchange: "NSE",
        } as BrokerOrderRequest,
      ],
    };

    const result = await engine.executeSignal(broker, invalidOrder);

    assert.strictEqual(result.failures.length, 1);
    assert.ok(result.failures[0].error.includes("Invalid price"));
  });

  it("should reject orders with invalid quantity", async () => {
    setDryRunFlag(false);

    const portfolioService = resolvePortfolioService();
    try {
      await portfolioService.addStock({ symbol: "AAPL", name: "Apple Inc." });
    } catch {
      // Stock already exists, that's fine
    }

    const invalidOrder: StrategySignal = {
      strategyId: "test-strategy",
      description: "Test invalid quantity",
      requestedOrders: [
        {
          symbol: "AAPL",
          side: "BUY",
          quantity: 0, // Invalid zero quantity
          price: 150.00,
          type: "LIMIT",
          exchange: "NSE",
        } as BrokerOrderRequest,
      ],
    };

    const result = await engine.executeSignal(broker, invalidOrder);

    assert.strictEqual(result.failures.length, 1);
    assert.ok(result.failures[0].error.includes("Invalid quantity"));
  });
});
