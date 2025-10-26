import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  BrokerOrderRequest,
  BrokerOrderExecution,
  HistoricalCandle,
} from "../types";
import ExecutionPlanner, { type ExecutionContext } from "./ExecutionPlanner";
import type BrokerClient from "../brokers/BrokerClient";

const createMockHistoricalData = (): HistoricalCandle[] => {
  return Array.from({ length: 30 }, (_, i) => ({
    symbol: "AAPL",
    open: 150 + i * 0.5,
    high: 155 + i * 0.5,
    low: 145 + i * 0.5,
    close: 150 + i * 0.5,
    volume: 1000000,
    timestamp: new Date(Date.now() - (30 - i) * 24 * 60 * 60 * 1000),
  }));
};

const createMockContext = (_volatility = 0.2): ExecutionContext => ({
  marketTick: {
    symbol: "AAPL",
    price: 160,
    volume: 50000,
    timestamp: new Date(),
  },
  historicalData: createMockHistoricalData(),
  averageDailyVolume: 1000000,
  timeOfDay: "MID_DAY",
});

class MockBroker implements BrokerClient {
  public readonly name = "mock";
  private executionCount = 0;

  async connect(): Promise<void> {
    // no-op
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  isConnected(): boolean {
    return true;
  }

  async getPositions() {
    return [];
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderExecution> {
    this.executionCount++;
    return {
      id: `mock-${this.executionCount}`,
      request: order,
      status: "FILLED",
      filledQuantity: order.quantity,
      averagePrice: order.price || 160,
      executedAt: new Date(),
    };
  }

  async cancelOrder(_orderId: string): Promise<void> {
    // no-op
  }

  async getQuote(_symbol: string, _side: "BUY" | "SELL") {
    return null;
  }

  getExecutionCount(): number {
    return this.executionCount;
  }

  reset(): void {
    this.executionCount = 0;
  }
}

describe("ExecutionPlanner", () => {
  it("plans execution for normal market conditions", async () => {
    const planner = new ExecutionPlanner();
    const context = createMockContext();

    const orders: BrokerOrderRequest[] = [
      {
        symbol: "AAPL",
        side: "BUY",
        quantity: 100,
        type: "MARKET",
      },
    ];

    const plan = await planner.planExecution(orders, context);

    assert.equal(plan.orders.length, 1);
    assert.equal(typeof plan.estimatedImpact, "number");
    assert.ok(["IMMEDIATE", "SPREAD", "DELAYED"].includes(plan.recommendedTiming));
    assert.ok(["MARKET", "LIMIT", "TWAP"].includes(plan.executionStrategy));
  });

  it("recommends LIMIT orders during high volatility", async () => {
    const planner = new ExecutionPlanner();

    // Create high volatility historical data
    const highVolatilityData = Array.from({ length: 30 }, (_, i) => ({
      symbol: "AAPL",
      open: 150 + (Math.random() - 0.5) * 20, // High volatility
      high: 155 + (Math.random() - 0.5) * 20,
      low: 145 + (Math.random() - 0.5) * 20,
      close: 150 + (Math.random() - 0.5) * 20,
      volume: 1000000,
      timestamp: new Date(Date.now() - (30 - i) * 24 * 60 * 60 * 1000),
    }));

    const context: ExecutionContext = {
      ...createMockContext(),
      historicalData: highVolatilityData,
    };

    const orders: BrokerOrderRequest[] = [
      {
        symbol: "AAPL",
        side: "BUY",
        quantity: 100,
        type: "MARKET",
      },
    ];

    const plan = await planner.planExecution(orders, context);

    // Should recommend LIMIT strategy for high volatility
    assert.ok(plan.executionStrategy === "LIMIT" || plan.recommendedTiming === "DELAYED");
  });

  it("recommends TWAP for large orders", async () => {
    const planner = new ExecutionPlanner();
    const context = createMockContext();

    const largeOrders: BrokerOrderRequest[] = [
      {
        symbol: "AAPL",
        side: "BUY",
        quantity: 5000, // Large order
        type: "MARKET",
        price: 160,
      },
    ];

    const plan = await planner.planExecution(largeOrders, context, {
      twapThreshold: 100000, // $100k threshold
    });

    // Large order value (5000 * 160 = $800k) should trigger TWAP
    assert.equal(plan.executionStrategy, "TWAP");
    assert.equal(plan.recommendedTiming, "SPREAD");
  });

  it("delays execution during market open with high volatility", async () => {
    const planner = new ExecutionPlanner();

    const highVolContext: ExecutionContext = {
      ...createMockContext(),
      timeOfDay: "MARKET_OPEN",
    };

    // Add high volatility historical data
    const highVolatilityData = Array.from({ length: 30 }, (_, i) => ({
      symbol: "AAPL",
      open: 150 + (Math.random() - 0.5) * 15,
      high: 155 + (Math.random() - 0.5) * 15,
      low: 145 + (Math.random() - 0.5) * 15,
      close: 150 + (Math.random() - 0.5) * 15,
      volume: 1000000,
      timestamp: new Date(Date.now() - (30 - i) * 24 * 60 * 60 * 1000),
    }));

    highVolContext.historicalData = highVolatilityData;

    const orders: BrokerOrderRequest[] = [
      {
        symbol: "AAPL",
        side: "BUY",
        quantity: 100,
        type: "MARKET",
      },
    ];

    const plan = await planner.planExecution(orders, highVolContext);

    assert.equal(plan.recommendedTiming, "DELAYED");
  });

  it("executes TWAP strategy correctly", async () => {
    const planner = new ExecutionPlanner();
    const mockBroker = new MockBroker();

    const orders: BrokerOrderRequest[] = [
      {
        symbol: "AAPL",
        side: "BUY",
        quantity: 600, // Will be split into slices
        type: "MARKET",
      },
    ];

    const result = await planner.executeWithTWAP(
      orders,
      mockBroker,
      0.1, // 0.1 minutes (6 seconds) for fast test
      3 // 3 slices
    );

    assert.equal(result.executed, 3); // Should execute 3 slices
    assert.equal(result.failed, 0);
    assert.equal(mockBroker.getExecutionCount(), 3);
  });

  it("provides execution recommendations", () => {
    const planner = new ExecutionPlanner();
    const context = createMockContext();

    const orders: BrokerOrderRequest[] = [
      {
        symbol: "AAPL",
        side: "BUY",
        quantity: 100,
        type: "MARKET",
        price: 160,
      },
      {
        symbol: "AAPL",
        side: "BUY",
        quantity: 10000, // Large order
        type: "MARKET",
        price: 160,
      },
    ];

    const recommendations = planner.getExecutionRecommendations(orders, context);

    assert.equal(recommendations.length, 2);
    assert.ok(recommendations.every(r => typeof r.symbol === "string"));
    assert.ok(recommendations.every(r => typeof r.recommendation === "string"));
    assert.ok(recommendations.every(r => typeof r.reason === "string"));

    // Large order should have different recommendation than small order
    const smallOrderRec = recommendations[0];
    const largeOrderRec = recommendations[1];
    assert.notEqual(smallOrderRec.recommendation, largeOrderRec.recommendation);
  });

  it("optimizes order sizing based on constraints", async () => {
    const planner = new ExecutionPlanner();

    const result1 = await planner.optimizeOrderSizing(
      10000, // Target $10k
      100,   // $100 per share
      15000  // $15k available cash
    );

    assert.equal(result1.quantity, 100); // Should get optimal quantity
    assert.equal(result1.value, 10000);
    assert.equal(result1.reasoning, "Optimal sizing achieved");

    const result2 = await planner.optimizeOrderSizing(
      10000, // Target $10k
      100,   // $100 per share
      5000   // Only $5k available cash
    );

    assert.equal(result2.quantity, 50); // Limited by cash
    assert.equal(result2.value, 5000);
    assert.equal(result2.reasoning, "Limited by available cash");
  });

  it("estimates market impact correctly", async () => {
    const planner = new ExecutionPlanner();
    const context = createMockContext();

    const smallOrder: BrokerOrderRequest[] = [
      {
        symbol: "AAPL",
        side: "BUY",
        quantity: 100, // Small relative to ADV
        type: "MARKET",
      },
    ];

    const largeOrder: BrokerOrderRequest[] = [
      {
        symbol: "AAPL",
        side: "BUY",
        quantity: 100000, // Large relative to ADV
        type: "MARKET",
      },
    ];

    const smallPlan = await planner.planExecution(smallOrder, context);
    const largePlan = await planner.planExecution(largeOrder, context);

    // Large order should have higher estimated impact
    assert.ok(largePlan.estimatedImpact > smallPlan.estimatedImpact);
  });
});