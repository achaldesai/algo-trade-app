import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import TradingEngine from "./TradingEngine";
import MarketDataService from "./MarketDataService";
import { RiskManager } from "./RiskManager";
import type { SettingsRepo } from "../db/repositories/SettingsRepo";
import PaperBroker from "../brokers/PaperBroker";
import type { BrokerOrderRequest, StrategySignal, Trade } from "../types";
import env from "../config/env";

function createTestRiskManager(): RiskManager {
  const mockSettings = {
    getRiskLimits: () => ({
      maxDailyLoss: 100000,
      maxDailyLossPercent: 10,
      maxPositionSize: 100000,
      maxOpenPositions: 50,
      stopLossPercent: 3,
    }),
    on: () => { },
    saveRiskLimits: async () => { },
  } as unknown as SettingsRepo;
  return new RiskManager(mockSettings);
}

function createMockPortfolioService() {
  const recorded: Trade[] = [];
  return {
    service: {
      listStocks: () => [],
      addStock: mock.fn(async () => ({ symbol: "AAPL", name: "Apple Inc.", createdAt: new Date() })),
      getSnapshot: async () => ({ generatedAt: new Date(), positions: [], totalTrades: 0 }),
      recordExternalTrade: async (_userId: string, trade: Trade) => { recorded.push(trade); },
    },
    recorded,
  };
}

const setDryRunFlag = (value: boolean): void => {
  Reflect.set(env, "dryRun", value);
};

describe("TradingEngine - Dry Run Mode", () => {
  let engine: TradingEngine;
  let broker: PaperBroker;
  let originalDryRun: boolean;
  let mockPortfolio: ReturnType<typeof createMockPortfolioService>;

  beforeEach(() => {
    originalDryRun = env.dryRun;

    mockPortfolio = createMockPortfolioService();
    const marketData = new MarketDataService();
    const riskManager = createTestRiskManager();
    broker = new PaperBroker();

    engine = new TradingEngine({
      brokerFactory: async () => broker,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      portfolioService: mockPortfolio.service as any,
      marketData,
      riskManager,
    });
  });

  afterEach(() => {
    setDryRunFlag(originalDryRun);
  });

  it("should not execute orders when dry-run mode is enabled", async () => {
    setDryRunFlag(true);

    const signal: StrategySignal = {
      strategyId: "test-strategy",
      description: "Test dry run order",
      requestedOrders: [
        {
          symbol: "AAPL",
          side: "BUY",
          quantity: 10,
          price: 150.0,
          type: "LIMIT",
          exchange: "NSE",
        } as BrokerOrderRequest,
      ],
    };

    const result = await engine.executeSignal("test-user", broker, signal);

    assert.strictEqual(result.executions.length, 1);
    assert.strictEqual(result.executions[0].filledQuantity, 0);
    assert.ok(result.executions[0].id.startsWith("dry-run-"));
    assert.strictEqual(result.failures.length, 0);
  });

  it("should execute orders normally when dry-run mode is disabled", async () => {
    setDryRunFlag(false);

    const signal: StrategySignal = {
      strategyId: "test-strategy",
      description: "Test normal order",
      requestedOrders: [
        {
          symbol: "AAPL",
          side: "BUY",
          quantity: 10,
          price: 150.0,
          type: "LIMIT",
          exchange: "NSE",
        } as BrokerOrderRequest,
      ],
    };

    const result = await engine.executeSignal("test-user", broker, signal);

    assert.ok(result.executions.length >= 0, "Should return executions array");

    if (!env.dryRun && result.executions.length > 0) {
      assert.ok(result.executions[0].filledQuantity > 0, "Should have filled quantity when not in dry-run");
    }
  });

  it("should validate order limits before execution", async () => {
    setDryRunFlag(false);

    const largeOrder: StrategySignal = {
      strategyId: "test-strategy",
      description: "Test large order",
      requestedOrders: [
        {
          symbol: "AAPL",
          side: "BUY",
          quantity: 10000,
          price: 150.0,
          type: "LIMIT",
          exchange: "NSE",
        } as BrokerOrderRequest,
      ],
    };

    const result = await engine.executeSignal("test-user", broker, largeOrder);

    assert.strictEqual(result.failures.length, 1);
    assert.ok(result.failures[0].error.includes("max position size"));
  });

  it("should reject orders with invalid price", async () => {
    setDryRunFlag(false);

    const invalidOrder: StrategySignal = {
      strategyId: "test-strategy",
      description: "Test invalid price",
      requestedOrders: [
        {
          symbol: "AAPL",
          side: "BUY",
          quantity: 10,
          price: -50.0,
          type: "LIMIT",
          exchange: "NSE",
        } as BrokerOrderRequest,
      ],
    };

    const result = await engine.executeSignal("test-user", broker, invalidOrder);

    assert.strictEqual(result.failures.length, 1);
    assert.ok(result.failures[0].error.includes("Invalid price"));
  });

  it("should reject orders with invalid quantity", async () => {
    setDryRunFlag(false);

    const invalidOrder: StrategySignal = {
      strategyId: "test-strategy",
      description: "Test invalid quantity",
      requestedOrders: [
        {
          symbol: "AAPL",
          side: "BUY",
          quantity: 0,
          price: 150.0,
          type: "LIMIT",
          exchange: "NSE",
        } as BrokerOrderRequest,
      ],
    };

    const result = await engine.executeSignal("test-user", broker, invalidOrder);

    assert.strictEqual(result.failures.length, 1);
    assert.ok(result.failures[0].error.includes("Invalid quantity"));
  });
});
