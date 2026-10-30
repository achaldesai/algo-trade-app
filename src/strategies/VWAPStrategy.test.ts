import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VWAPStrategy } from "./VWAPStrategy";
import type { StrategyContext } from "./BaseStrategy";
import type BrokerClient from "../brokers/BrokerClient";
import type { MarketTick, PortfolioPositionSnapshot } from "../types";

const USER_ID = "user-1";
const SYMBOL = "RELIANCE";

const paperBroker = {
  name: "paper",
  connect: async () => {},
  disconnect: async () => {},
  isConnected: () => true,
  getPositions: async () => [],
  placeOrder: async () => ({}),
  cancelOrder: async () => {},
  getQuote: async () => null,
} as unknown as BrokerClient;

function makeTick(price: number, vwap: number): MarketTick {
  return {
    symbol: SYMBOL,
    price,
    volume: 1000,
    averagePrice: vwap,
    timestamp: new Date(),
  };
}

function makePosition(netQuantity: number): PortfolioPositionSnapshot {
  return {
    symbol: SYMBOL,
    name: "Reliance Industries",
    netQuantity,
    averageEntryPrice: 100,
    realizedPnl: 0,
    position: netQuantity > 0 ? "LONG" : netQuantity < 0 ? "SHORT" : "FLAT",
    unrealizedPnl: 0,
  };
}

function buildContext(price: number, vwap: number, netQuantity: number): StrategyContext {
  return {
    market: {
      ticks: [makeTick(price, vwap)],
      asOf: new Date(),
    },
    portfolio: {
      generatedAt: new Date(),
      positions: netQuantity === 0 ? [] : [makePosition(netQuantity)],
      totalTrades: 0,
    },
    broker: paperBroker,
    params: { threshold: 0.01, orderSize: 10, cooldownMs: 300000 },
    userId: USER_ID,
  };
}

describe("VWAPStrategy", () => {
  it("emits one BUY signal when flat and price is below VWAP by more than threshold", async () => {
    const strategy = new VWAPStrategy();
    const signals = await strategy.generateSignals(buildContext(98, 100, 0));

    assert.equal(signals.length, 1);
    assert.equal(signals[0].requestedOrders[0].side, "BUY");
    assert.equal(signals[0].requestedOrders[0].quantity, 10);
  });

  it("does not pyramid a BUY when already long", async () => {
    const strategy = new VWAPStrategy();
    const signals = await strategy.generateSignals(buildContext(98, 100, 10));

    assert.equal(signals.length, 0);
  });

  it("emits one SELL of the full position when long and price is above VWAP by more than threshold", async () => {
    const strategy = new VWAPStrategy();
    const signals = await strategy.generateSignals(buildContext(103, 100, 10));

    assert.equal(signals.length, 1);
    assert.equal(signals[0].requestedOrders[0].side, "SELL");
    assert.equal(signals[0].requestedOrders[0].quantity, 10);
  });

  it("does not signal when flat and price is above VWAP", async () => {
    const strategy = new VWAPStrategy();
    const signals = await strategy.generateSignals(buildContext(103, 100, 0));

    assert.equal(signals.length, 0);
  });

  it("cooldown suppresses a second signal on the same user/symbol within cooldownMs", async () => {
    const strategy = new VWAPStrategy();

    const first = await strategy.generateSignals(buildContext(98, 100, 0));
    const second = await strategy.generateSignals(buildContext(98, 100, 0));

    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
  });
});
