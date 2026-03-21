import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import PortfolioService from "./PortfolioService";
import type { PortfolioRepo } from "../db/repositories/PortfolioRepo";
import type { Stock, Trade, TradeSide } from "../types";

const uniqueSymbol = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000)}`;

// In-memory mock PortfolioRepo
function createMockRepo(): PortfolioRepo {
  const stocks = new Map<string, Stock>();
  const trades = new Map<string, Trade>();

  return {
    db: {} as unknown,
    listStocks: (_userId: string) => {
      return Array.from(stocks.values())
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
    },
    findStock: (_userId: string, symbol: string) => {
      return stocks.get(symbol.toUpperCase());
    },
    createStock: async (_userId: string, input: { symbol: string; name: string }) => {
      const stock: Stock = { symbol: input.symbol.toUpperCase(), name: input.name, createdAt: new Date() };
      stocks.set(stock.symbol, stock);
      return stock;
    },
    ensureStock: async (_userId: string, input: { symbol: string; name: string }) => {
      const existing = stocks.get(input.symbol.toUpperCase());
      if (existing) return existing;
      const stock: Stock = { symbol: input.symbol.toUpperCase(), name: input.name, createdAt: new Date() };
      stocks.set(stock.symbol, stock);
      return stock;
    },
    listTrades: (_userId: string) => {
      return Array.from(trades.values()).sort((a, b) => {
        const diff = a.executedAt.getTime() - b.executedAt.getTime();
        if (diff !== 0) return diff;
        return a.id.localeCompare(b.id);
      });
    },
    createTrade: async (_userId: string, input: { id: string; symbol: string; side: TradeSide; quantity: number; price: number; executedAt: Date; notes?: string }) => {
      const trade: Trade = {
        id: input.id,
        symbol: input.symbol.toUpperCase(),
        side: input.side,
        quantity: Math.round(input.quantity),
        price: Number(input.price),
        executedAt: input.executedAt,
        notes: input.notes,
      };
      trades.set(trade.id, trade);
      return trade;
    },
    createTradeIfMissing: async (_userId: string, input: { id: string; symbol: string; side: TradeSide; quantity: number; price: number; executedAt: Date; notes?: string }) => {
      if (trades.has(input.id)) return false;
      const trade: Trade = {
        id: input.id,
        symbol: input.symbol.toUpperCase(),
        side: input.side,
        quantity: Math.round(input.quantity),
        price: Number(input.price),
        executedAt: input.executedAt,
        notes: input.notes,
      };
      trades.set(trade.id, trade);
      return true;
    },
    recordTradeAtomic: async (_userId: string, stockInput: { symbol: string; name: string }, tradeInput: { id: string; symbol: string; side: TradeSide; quantity: number; price: number; executedAt: Date; notes?: string }) => {
      const symbol = stockInput.symbol.toUpperCase();
      let stock = stocks.get(symbol);
      let created = false;
      if (!stock) {
        stock = { symbol, name: stockInput.name, createdAt: new Date() };
        stocks.set(symbol, stock);
        created = true;
      }
      const trade: Trade = {
        id: tradeInput.id,
        symbol: tradeInput.symbol.toUpperCase(),
        side: tradeInput.side,
        quantity: Math.round(tradeInput.quantity),
        price: Number(tradeInput.price),
        executedAt: tradeInput.executedAt,
        notes: tradeInput.notes,
      };
      trades.set(trade.id, trade);
      return { stock, trade, created };
    },
  } as unknown as PortfolioRepo;
}

let service: PortfolioService;

describe("PortfolioService trade handling", () => {
  beforeEach(() => {
    service = new PortfolioService(createMockRepo());
  });

  it("records realized PnL when covering short positions", async () => {
    const symbol = uniqueSymbol("SHORT");
    await service.addStock("test-user", { symbol, name: "Short Instrument" });

    await service.addTrade("test-user", {
      symbol,
      side: "SELL",
      quantity: 10,
      price: 50,
      executedAt: new Date("2024-01-01T10:00:00.000Z"),
    });

    await service.addTrade("test-user", {
      symbol,
      side: "BUY",
      quantity: 6,
      price: 40,
      executedAt: new Date("2024-01-02T10:00:00.000Z"),
    });

    let summary = (await service.getTradeSummaries("test-user")).find((item) => item.symbol === symbol.toUpperCase());
    assert(summary);
    assert.equal(summary.netQuantity, -4);
    assert.equal(summary.averageEntryPrice, 50);
    assert.equal(summary.realizedPnl, 60);
    assert.equal(summary.position, "SHORT");

    await service.addTrade("test-user", {
      symbol,
      side: "BUY",
      quantity: 4,
      price: 55,
      executedAt: new Date("2024-01-03T10:00:00.000Z"),
    });

    summary = (await service.getTradeSummaries("test-user")).find((item) => item.symbol === symbol.toUpperCase());
    assert(summary);
    assert.equal(summary.netQuantity, 0);
    assert.equal(summary.averageEntryPrice, 0);
    assert.equal(summary.realizedPnl, 40);
    assert.equal(summary.position, "FLAT");
  });

  it("keeps mark prices aligned with the most recent execution", async () => {
    const symbol = uniqueSymbol("MARK");
    await service.addStock("test-user", { symbol, name: "Mark Instrument" });

    await service.addTrade("test-user", {
      symbol,
      side: "BUY",
      quantity: 10,
      price: 100,
      executedAt: new Date("2024-06-01T10:00:00.000Z"),
    });

    await service.addTrade("test-user", {
      symbol,
      side: "BUY",
      quantity: 5,
      price: 110,
      executedAt: new Date("2024-06-02T10:00:00.000Z"),
    });

    await service.recordExternalTrade("test-user", {
      id: "external-old",
      symbol,
      side: "BUY",
      quantity: 1,
      price: 90,
      executedAt: new Date("2024-05-01T10:00:00.000Z"),
    });

    const snapshot = await service.getSnapshot("test-user");
    const position = snapshot.positions.find((item) => item.symbol === symbol.toUpperCase());
    assert(position);
    assert.equal(position.netQuantity, 16);
    assert.equal(position.averageEntryPrice, 102.5);
    assert.equal(position.unrealizedPnl, 120);
  });
});
