import assert from "node:assert/strict";
import { describe, it } from "node:test";
import PortfolioService from "./PortfolioService";

const buildServiceWithStock = (symbol: string, name = symbol): PortfolioService => {
  const service = new PortfolioService();
  service.addStock({ symbol, name });
  return service;
};

describe("PortfolioService trade handling", () => {
  it("records realized PnL when covering short positions", () => {
    const service = buildServiceWithStock("TSLA", "Tesla");

    service.addTrade({
      symbol: "TSLA",
      side: "SELL",
      quantity: 10,
      price: 50,
      executedAt: new Date("2024-01-01T10:00:00.000Z"),
    });

    service.addTrade({
      symbol: "TSLA",
      side: "BUY",
      quantity: 6,
      price: 40,
      executedAt: new Date("2024-01-02T10:00:00.000Z"),
    });

    let summary = service.getTradeSummaries().find((item) => item.symbol === "TSLA");
    assert(summary);
    assert.equal(summary.netQuantity, -4);
    assert.equal(summary.averageEntryPrice, 50);
    assert.equal(summary.realizedPnl, 60);
    assert.equal(summary.position, "SHORT");

    service.addTrade({
      symbol: "TSLA",
      side: "BUY",
      quantity: 4,
      price: 55,
      executedAt: new Date("2024-01-03T10:00:00.000Z"),
    });

    summary = service.getTradeSummaries().find((item) => item.symbol === "TSLA");
    assert(summary);
    assert.equal(summary.netQuantity, 0);
    assert.equal(summary.averageEntryPrice, 0);
    assert.equal(summary.realizedPnl, 40);
    assert.equal(summary.position, "FLAT");
  });

  it("keeps mark prices aligned with the most recent execution", () => {
    const service = buildServiceWithStock("AAPL", "Apple");

    service.addTrade({
      symbol: "AAPL",
      side: "BUY",
      quantity: 10,
      price: 100,
      executedAt: new Date("2024-06-01T10:00:00.000Z"),
    });

    service.addTrade({
      symbol: "AAPL",
      side: "BUY",
      quantity: 5,
      price: 110,
      executedAt: new Date("2024-06-02T10:00:00.000Z"),
    });

    service.recordExternalTrade({
      id: "external-old",
      symbol: "AAPL",
      side: "BUY",
      quantity: 1,
      price: 90,
      executedAt: new Date("2024-05-01T10:00:00.000Z"),
    });

    const snapshot = service.getSnapshot();
    const position = snapshot.positions.find((item) => item.symbol === "AAPL");
    assert(position);
    assert.equal(position.netQuantity, 16);
    assert.equal(position.averageEntryPrice, 102.5);
    assert.equal(position.unrealizedPnl, 120);
  });
});
