import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { ensurePortfolioStore, getPortfolioRepository, resetPortfolioStore } from "../persistence";
import PortfolioService from "./PortfolioService";

let service: PortfolioService;

const uniqueSymbol = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000)}`;

describe("PortfolioService trade handling", () => {
  before(async () => {
    await ensurePortfolioStore();
  });

  beforeEach(async () => {
    await resetPortfolioStore();
    service = new PortfolioService(getPortfolioRepository());
  });

  it("records realized PnL when covering short positions", async () => {
    const symbol = uniqueSymbol("SHORT");
    await service.addStock({ symbol, name: "Short Instrument" });

    await service.addTrade({
      symbol,
      side: "SELL",
      quantity: 10,
      price: 50,
      executedAt: new Date("2024-01-01T10:00:00.000Z"),
    });

    await service.addTrade({
      symbol,
      side: "BUY",
      quantity: 6,
      price: 40,
      executedAt: new Date("2024-01-02T10:00:00.000Z"),
    });

    let summary = (await service.getTradeSummaries()).find((item) => item.symbol === symbol);
    assert(summary);
    assert.equal(summary.netQuantity, -4);
    assert.equal(summary.averageEntryPrice, 50);
    assert.equal(summary.realizedPnl, 60);
    assert.equal(summary.position, "SHORT");

    await service.addTrade({
      symbol,
      side: "BUY",
      quantity: 4,
      price: 55,
      executedAt: new Date("2024-01-03T10:00:00.000Z"),
    });

    summary = (await service.getTradeSummaries()).find((item) => item.symbol === symbol);
    assert(summary);
    assert.equal(summary.netQuantity, 0);
    assert.equal(summary.averageEntryPrice, 0);
    assert.equal(summary.realizedPnl, 40);
    assert.equal(summary.position, "FLAT");
  });

  it("keeps mark prices aligned with the most recent execution", async () => {
    const symbol = uniqueSymbol("MARK");
    await service.addStock({ symbol, name: "Mark Instrument" });

    await service.addTrade({
      symbol,
      side: "BUY",
      quantity: 10,
      price: 100,
      executedAt: new Date("2024-06-01T10:00:00.000Z"),
    });

    await service.addTrade({
      symbol,
      side: "BUY",
      quantity: 5,
      price: 110,
      executedAt: new Date("2024-06-02T10:00:00.000Z"),
    });

    await service.recordExternalTrade({
      id: "external-old",
      symbol,
      side: "BUY",
      quantity: 1,
      price: 90,
      executedAt: new Date("2024-05-01T10:00:00.000Z"),
    });

    const snapshot = await service.getSnapshot();
    const position = snapshot.positions.find((item) => item.symbol === symbol);
    assert(position);
    assert.equal(position.netQuantity, 16);
    assert.equal(position.averageEntryPrice, 102.5);
    assert.equal(position.unrealizedPnl, 120);
  });
});
