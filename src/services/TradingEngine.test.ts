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
import BaseStrategy, { type StrategyContext } from "../strategies/BaseStrategy";
import { resolveRiskManager } from "../container";

class FailingBroker implements BrokerClient {
  public readonly name = "failing";

  public connectAttempts = 0;

  async connect(): Promise<void> {
    this.connectAttempts += 1;
    throw new Error("connect failed");
  }

  async disconnect(): Promise<void> {
    // no-op for tests
  }

  isConnected(): boolean {
    return false;
  }

  async getPositions(): Promise<Trade[]> {
    return [];
  }

  async placeOrder(_order: BrokerOrderRequest): Promise<BrokerOrderExecution> {
    throw new Error("primary broker should not execute orders");
  }

  async cancelOrder(_orderId: string): Promise<void> {
    // no-op for tests
  }

  async getQuote(): Promise<null> {
    return null;
  }
}

class RecordingBroker implements BrokerClient {
  public readonly name = "recording";

  public connectCalls = 0;

  private connected = false;

  public readonly orders: BrokerOrderRequest[] = [];

  async connect(): Promise<void> {
    this.connectCalls += 1;
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

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderExecution> {
    this.orders.push(order);
    return {
      id: `order-${this.orders.length}`,
      request: order,
      status: "FILLED",
      filledQuantity: order.quantity,
      averagePrice: order.price ?? 100,
      executedAt: new Date(),
    } satisfies BrokerOrderExecution;
  }

  async cancelOrder(_orderId: string): Promise<void> {
    // no-op for tests
  }

  async getQuote(): Promise<null> {
    return null;
  }
}

class AlwaysFailingBroker implements BrokerClient {
  public readonly name = "unavailable";
  public connectAttempts = 0;

  async connect(): Promise<void> {
    this.connectAttempts++;
    throw new Error("connect failed");
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  isConnected(): boolean {
    return false;
  }

  async getPositions(): Promise<Trade[]> {
    return [];
  }

  async placeOrder(_order: BrokerOrderRequest): Promise<BrokerOrderExecution> {
    throw new Error("placeOrder failed");
  }

  async cancelOrder(_orderId: string): Promise<void> {
    throw new Error("cancelOrder failed");
  }

  async getQuote(_symbol: string, _side: "BUY" | "SELL") {
    return null;
  }
}

class TestStrategy extends BaseStrategy {
  constructor(private readonly expectedBroker: BrokerClient) {
    super("test-strategy", "Test Strategy", "Exercise broker fallback");
  }

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
            price: 150,  // Include price for validation
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
  it("surfaces connection errors and falls back to the provided broker", async () => {
    const failingBroker = new FailingBroker();
    const fallbackBroker = new RecordingBroker();
    const { service: portfolioService, recorded } = createPortfolioServiceStub();
    const marketData = new MarketDataService();
    const riskManager = resolveRiskManager();

    const engine = new TradingEngine({
      broker: failingBroker,
      fallbackBroker,
      portfolioService,
      marketData,
      riskManager,
    });

    const strategy = new TestStrategy(fallbackBroker);
    engine.registerStrategy(strategy);

    const result = await engine.evaluate(strategy.id);

    assert.equal(failingBroker.connectAttempts, 1);
    assert.equal(fallbackBroker.connectCalls, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].stage, "BROKER_CONNECTION");
    assert.match(result.errors[0].message, /connect failed/i);
    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0].executions.length, 1);
    assert.equal(result.executions[0].failures.length, 0);
    assert.equal(fallbackBroker.orders.length, 1);
    assert.equal(recorded.length, 1);
  });

  it("returns structured errors when both primary and fallback brokers fail", async () => {
    const failingBroker = new FailingBroker();
    const fallbackBroker = new AlwaysFailingBroker();
    const { service: portfolioService } = createPortfolioServiceStub();
    const marketData = new MarketDataService();
    const riskManager = resolveRiskManager();

    const engine = new TradingEngine({
      broker: failingBroker,
      fallbackBroker,
      portfolioService,
      marketData,
      riskManager,
    });

    engine.registerStrategy(new GuardStrategy());

    const result = await engine.evaluate("guard-strategy");

    assert.equal(failingBroker.connectAttempts, 1);
    assert.equal(fallbackBroker.connectAttempts, 1);
    assert.equal(result.executions.length, 0);
    assert.equal(result.errors.length, 2);
    assert(result.errors.every((error) => error.stage === "BROKER_CONNECTION"));
  });
});

