import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type BrokerClient from "../brokers/BrokerClient";
import type {
  BrokerOrderExecution,
  BrokerOrderRequest,
  PortfolioSnapshot,
  StrategySignal,
  Trade,
} from "../types";
import MarketDataService from "./MarketDataService";
import type PortfolioService from "./PortfolioService";
import TradingEngine from "./TradingEngine";
import BaseStrategy, { type StrategyContext, type StrategyParamDefinition } from "../strategies/BaseStrategy";
import { RiskManager } from "./RiskManager";
import type { SettingsRepo } from "../db/repositories/SettingsRepo";

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

class FailingBroker implements BrokerClient {
  public readonly name = "failing";
  public connectAttempts = 0;

  async connect(): Promise<void> {
    this.connectAttempts += 1;
    throw new Error("connect failed");
  }

  async disconnect(): Promise<void> { }

  isConnected(): boolean {
    return false;
  }

  async getPositions(): Promise<Trade[]> {
    return [];
  }

  async placeOrder(_order: BrokerOrderRequest): Promise<BrokerOrderExecution> {
    throw new Error("primary broker should not execute orders");
  }

  async cancelOrder(_orderId: string): Promise<void> { }

  async getQuote(): Promise<null> {
    return null;
  }
}

class PlaceOrderFailingBroker implements BrokerClient {
  public readonly name = "place-order-failing";
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getPositions(): Promise<Trade[]> {
    return [];
  }

  async placeOrder(_order: BrokerOrderRequest): Promise<BrokerOrderExecution> {
    throw new Error("placeOrder rejected");
  }

  async cancelOrder(_orderId: string): Promise<void> { }

  async getQuote(): Promise<null> {
    return null;
  }
}

class TestStrategy extends BaseStrategy {
  constructor(private readonly expectedBroker: BrokerClient) {
    super("test-strategy", "Test Strategy", "Exercise broker fallback");
  }

  getParamSchema(): StrategyParamDefinition[] { return []; }
  getDefaultParams(): Record<string, unknown> { return {}; }

  async generateSignals(context: StrategyContext): Promise<StrategySignal[]> {
    assert.equal(context.broker, this.expectedBroker);
    return [
      {
        strategyId: this.id,
        description: "Buy AAPL via fallback",
        requestedOrders: [
          {
            symbol: "AAPL",
            side: "BUY",
            quantity: 1,
            price: 150,
            type: "MARKET",
          },
        ],
      },
    ];
  }
}

class GuardStrategy extends BaseStrategy {
  constructor() {
    super("guard-strategy", "Guard Strategy", "Should never execute when brokers are unavailable");
  }

  getParamSchema(): StrategyParamDefinition[] { return []; }
  getDefaultParams(): Record<string, unknown> { return {}; }

  async generateSignals(): Promise<StrategySignal[]> {
    throw new Error("generateSignals should not run when both brokers fail");
  }
}

const createPortfolioServiceStub = () => {
  const recorded: Trade[] = [];

  const service = {
    async getSnapshot(): Promise<PortfolioSnapshot> {
      return {
        generatedAt: new Date(),
        positions: [],
        totalTrades: recorded.length,
      } satisfies PortfolioSnapshot;
    },
    async recordExternalTrade(trade: Trade): Promise<void> {
      recorded.push(trade);
    },
  } as unknown as PortfolioService;

  return { service, recorded };
};

describe("TradingEngine broker fallback", () => {
  it("fails closed (no trades) when the broker cannot connect", async () => {
    const failingBroker = new FailingBroker();
    const { service: portfolioService, recorded } = createPortfolioServiceStub();
    const marketData = new MarketDataService();
    const riskManager = createTestRiskManager();

    const engine = new TradingEngine({
      brokerFactory: async () => failingBroker,
      portfolioService,
      marketData,
      riskManager,
    });

    const unavailableEvents: unknown[] = [];
    engine.on("broker-unavailable", (data) => unavailableEvents.push(data));

    engine.registerStrategy(new GuardStrategy());

    const result = await engine.evaluate("guard-strategy", "test-user");

    assert.equal(failingBroker.connectAttempts, 1);
    assert.equal(result.executions.length, 0);
    assert.equal(recorded.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].stage, "BROKER_CONNECTION");
    assert.match(result.errors[0].message, /connect failed/i);
    assert.equal(unavailableEvents.length, 1);
  });

  it("does not record a phantom trade and emits trade-failed when placeOrder rejects", async () => {
    const broker = new PlaceOrderFailingBroker();
    const { service: portfolioService, recorded } = createPortfolioServiceStub();
    const marketData = new MarketDataService();
    const riskManager = createTestRiskManager();

    const engine = new TradingEngine({
      brokerFactory: async () => broker,
      portfolioService,
      marketData,
      riskManager,
    });

    const failedEvents: unknown[] = [];
    engine.on("trade-failed", (data) => failedEvents.push(data));

    const strategy = new TestStrategy(broker);
    engine.registerStrategy(strategy);

    const result = await engine.evaluate(strategy.id, "test-user");

    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0].failures.length, 1);
    assert.equal(recorded.length, 0);
    assert.equal(failedEvents.length, 1);
  });

  it("throttles broker-unavailable alerts to one per cooldown window", async () => {
    const failingBroker = new FailingBroker();
    const { service: portfolioService } = createPortfolioServiceStub();
    const marketData = new MarketDataService();
    const riskManager = createTestRiskManager();

    const engine = new TradingEngine({
      brokerFactory: async () => failingBroker,
      portfolioService,
      marketData,
      riskManager,
    });

    const unavailableEvents: unknown[] = [];
    engine.on("broker-unavailable", (data) => unavailableEvents.push(data));

    engine.registerStrategy(new GuardStrategy());

    await engine.evaluate("guard-strategy", "test-user");
    await engine.evaluate("guard-strategy", "test-user");

    assert.equal(unavailableEvents.length, 1);
  });
});
