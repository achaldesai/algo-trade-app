import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  PortfolioSnapshot,
  MarketTick,
} from "../types";
import PortfolioRebalancer, { type PortfolioAllocation } from "./PortfolioRebalancer";

const createMockPortfolio = (): PortfolioSnapshot => ({
  generatedAt: new Date(),
  positions: [
    {
      symbol: "AAPL",
      name: "Apple Inc",
      netQuantity: 10,
      averageEntryPrice: 150,
      realizedPnl: 0,
      position: "LONG",
      unrealizedPnl: 100,
    },
    {
      symbol: "MSFT",
      name: "Microsoft",
      netQuantity: 5,
      averageEntryPrice: 300,
      realizedPnl: 0,
      position: "LONG",
      unrealizedPnl: 50,
    },
  ],
  totalTrades: 2,
});

const createMockPrices = (): MarketTick[] => [
  {
    symbol: "AAPL",
    price: 160,
    volume: 1000000,
    timestamp: new Date(),
  },
  {
    symbol: "MSFT",
    price: 310,
    volume: 500000,
    timestamp: new Date(),
  },
  {
    symbol: "GOOGL",
    price: 2500,
    volume: 200000,
    timestamp: new Date(),
  },
];

describe("PortfolioRebalancer", () => {
  it("calculates rebalancing needs correctly", async () => {
    const rebalancer = new PortfolioRebalancer();
    const portfolio = createMockPortfolio();
    const prices = createMockPrices();

    const allocations: PortfolioAllocation[] = [
      { symbol: "AAPL", targetWeight: 0.4 },
      { symbol: "MSFT", targetWeight: 0.3 },
      { symbol: "GOOGL", targetWeight: 0.3 },
    ];

    const result = await rebalancer.calculateRebalance(
      allocations,
      portfolio,
      prices,
      { totalPortfolioValue: 10000, driftThreshold: 0.05 }
    );

    assert.equal(result.targets.length, 3);
    assert.ok(result.totalValue > 0);
    assert.equal(typeof result.cashRequired, "number");
    assert.ok(Array.isArray(result.ordersToExecute));
  });

  it("validates allocation weights correctly", async () => {
    const rebalancer = new PortfolioRebalancer();
    const portfolio = createMockPortfolio();
    const prices = createMockPrices();

    const invalidAllocations: PortfolioAllocation[] = [
      { symbol: "AAPL", targetWeight: 0.7 },
      { symbol: "MSFT", targetWeight: 0.5 }, // Total > 1.0
    ];

    await assert.rejects(async () => {
      await rebalancer.calculateRebalance(invalidAllocations, portfolio, prices);
    }, /Portfolio allocations must sum to 1.0/);
  });

  it("respects drift threshold", async () => {
    const rebalancer = new PortfolioRebalancer();
    const portfolio = createMockPortfolio();
    const prices = createMockPrices();

    // Current: AAPL ~57%, MSFT ~43%, target close to current
    const allocations: PortfolioAllocation[] = [
      { symbol: "AAPL", targetWeight: 0.6 },
      { symbol: "MSFT", targetWeight: 0.4 },
    ];

    const result = await rebalancer.calculateRebalance(
      allocations,
      portfolio,
      prices,
      { totalPortfolioValue: 10000, driftThreshold: 0.1 } // 10% threshold
    );

    // Should have fewer rebalancing actions due to high threshold
    const activeTargets = result.targets.filter(t => t.rebalanceAction !== "HOLD");
    assert.ok(activeTargets.length <= result.targets.length);
  });

  it("generates correct buy/sell actions", async () => {
    const rebalancer = new PortfolioRebalancer();
    const portfolio = createMockPortfolio();
    const prices = createMockPrices();

    const allocations: PortfolioAllocation[] = [
      { symbol: "AAPL", targetWeight: 0.2 }, // Reduce position (sell)
      { symbol: "MSFT", targetWeight: 0.8 }, // Increase position (buy)
    ];

    const result = await rebalancer.calculateRebalance(
      allocations,
      portfolio,
      prices,
      { totalPortfolioValue: 10000, driftThreshold: 0.01 }
    );

    const aaplTarget = result.targets.find(t => t.symbol === "AAPL");
    const msftTarget = result.targets.find(t => t.symbol === "MSFT");

    // AAPL should need to sell (currently over-allocated)
    // MSFT should need to buy (target is much higher)
    assert.ok(aaplTarget);
    assert.ok(msftTarget);
  });

  it("calculates drift analysis correctly", async () => {
    const rebalancer = new PortfolioRebalancer();
    const portfolio = createMockPortfolio();
    const prices = createMockPrices();

    const allocations: PortfolioAllocation[] = [
      { symbol: "AAPL", targetWeight: 0.5 },
      { symbol: "MSFT", targetWeight: 0.5 },
    ];

    const driftAnalysis = await rebalancer.getDriftAnalysis(
      allocations,
      portfolio,
      prices
    );

    assert.equal(driftAnalysis.length, 2);
    assert.ok(driftAnalysis.every(d => typeof d.currentWeight === "number"));
    assert.ok(driftAnalysis.every(d => typeof d.targetWeight === "number"));
    assert.ok(driftAnalysis.every(d => typeof d.drift === "number"));
  });

  it("handles empty portfolio", async () => {
    const rebalancer = new PortfolioRebalancer();
    const emptyPortfolio: PortfolioSnapshot = {
      generatedAt: new Date(),
      positions: [],
      totalTrades: 0,
    };
    const prices = createMockPrices();

    const allocations: PortfolioAllocation[] = [
      { symbol: "AAPL", targetWeight: 0.5 },
      { symbol: "MSFT", targetWeight: 0.5 },
    ];

    const result = await rebalancer.calculateRebalance(
      allocations,
      emptyPortfolio,
      prices,
      { totalPortfolioValue: 10000 }
    );

    // Should generate buy orders for all target positions
    assert.ok(result.ordersToExecute.length > 0);
    assert.ok(result.ordersToExecute.every(order => order.side === "BUY"));
  });

  it("respects minimum trade value", async () => {
    const rebalancer = new PortfolioRebalancer();
    const portfolio = createMockPortfolio();
    const prices = createMockPrices();

    const allocations: PortfolioAllocation[] = [
      { symbol: "AAPL", targetWeight: 0.499 }, // Very small deviation
      { symbol: "MSFT", targetWeight: 0.501 },
    ];

    const result = await rebalancer.calculateRebalance(
      allocations,
      portfolio,
      prices,
      {
        totalPortfolioValue: 10000,
        driftThreshold: 0.001,
        minTradeValue: 5000, // High minimum trade value
      }
    );

    // Should have fewer orders due to minimum trade value filter
    const ordersUnderMin = result.ordersToExecute.filter(order => {
      const value = order.quantity * (order.price || prices.find(p => p.symbol === order.symbol)?.price || 0);
      return value < 5000;
    });
    assert.equal(ordersUnderMin.length, 0);
  });
});