import assert from "node:assert/strict";
import express from "express";
import { EventEmitter, once } from "node:events";
import { describe, it, mock, beforeEach } from "node:test";
import { createRequest, createResponse, type RequestMethod } from "node-mocks-http";
import errorHandler from "../middleware/errorHandler";
import tradesRouter from "./trades";
import type { AppContainer } from "../container";

interface RequestOptions {
  method: RequestMethod;
  url: string;
  body?: unknown;
}

const allTrades: Array<{
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  executedAt: Date;
  notes?: string;
}> = [];

const mockPortfolioService = {
  listTrades: mock.fn(() => allTrades),
  addTrade: mock.fn(async (_userId: string, input: { symbol: string; side: string; quantity: number; price: number; executedAt?: Date; notes?: string }) => {
    const trade = {
      id: `trade-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      symbol: input.symbol,
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      executedAt: input.executedAt ?? new Date(),
      notes: input.notes,
    };
    allTrades.push(trade);
    return trade;
  }),
  getTradeSummaries: mock.fn(() => {
    // Compute simple summaries from allTrades
    const map = new Map<string, { netQty: number; totalBuy: number; totalSell: number; buyQty: number; sellQty: number }>();
    for (const t of allTrades) {
      const s = map.get(t.symbol) ?? { netQty: 0, totalBuy: 0, totalSell: 0, buyQty: 0, sellQty: 0 };
      if (t.side === "BUY") {
        s.netQty += t.quantity;
        s.totalBuy += t.quantity * t.price;
        s.buyQty += t.quantity;
      } else {
        s.netQty -= t.quantity;
        s.totalSell += t.quantity * t.price;
        s.sellQty += t.quantity;
      }
      map.set(t.symbol, s);
    }
    return Array.from(map.entries()).map(([symbol, s]) => {
      const closingQty = Math.min(s.buyQty, s.sellQty);
      const avgBuy = s.buyQty > 0 ? s.totalBuy / s.buyQty : 0;
      const avgSell = s.sellQty > 0 ? s.totalSell / s.sellQty : 0;
      const realized = closingQty * (avgSell - avgBuy);
      return {
        symbol,
        name: symbol,
        netQuantity: s.netQty,
        realizedPnl: realized,
        averageEntryPrice: s.netQty !== 0 ? (s.netQty > 0 ? avgBuy : avgSell) : 0,
        position: s.netQty > 0 ? "LONG" : s.netQty < 0 ? "SHORT" : "FLAT",
      };
    });
  }),
  getSnapshot: mock.fn(() => ({
    positions: [],
    totalTrades: allTrades.length,
    generatedAt: new Date(),
  })),
};

const testApp = express();
testApp.use(express.json());
testApp.use((req, _res, next) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).user = { userId: "test-user" };
  next();
});
testApp.locals.container = { portfolioService: mockPortfolioService } as unknown as AppContainer;
testApp.use("/api/trades", tradesRouter);
testApp.use(errorHandler);

const invokeApp = async ({ method, url, body }: RequestOptions) => {
  const req = createRequest({
    method,
    url,
    headers: { "content-type": "application/json" },
  });
  if (typeof body !== "undefined") {
    req.body = body;
  }
  const res = createResponse({ eventEmitter: EventEmitter });
  const waitForEnd = once(res, "end");
  testApp(req, res);
  req.emit("end");
  await waitForEnd;
  return res;
};

describe("/api/trades routes", () => {
  beforeEach(() => {
    allTrades.length = 0;
    mockPortfolioService.listTrades.mock.resetCalls();
    mockPortfolioService.addTrade.mock.resetCalls();
  });

  it("creates a trade", async () => {
    const payload = {
      symbol: "RELIANCE",
      side: "BUY",
      quantity: 5,
      price: 2500.5,
      notes: "Test trade",
      executedAt: new Date("2023-01-01T10:00:00.000Z").toISOString(),
    };

    const res = await invokeApp({ method: "POST", url: "/api/trades", body: payload });
    assert.equal(res.statusCode, 201);

    const body = res._getJSONData() as {
      data: {
        id: string;
        symbol: string;
        side: string;
        quantity: number;
        price: number;
        executedAt: string;
        notes?: string;
      };
    };

    assert.equal(body.data.symbol, "RELIANCE");
    assert.equal(body.data.side, "BUY");
    assert.equal(body.data.quantity, 5);
    assert.equal(body.data.price, 2500.5);
    assert.equal(body.data.notes, "Test trade");
    assert.equal(body.data.executedAt, "2023-01-01T10:00:00.000Z");

    const stored = allTrades.find((trade: { id: string }) => trade.id === body.data.id);
    assert(stored);
    assert.equal(stored.symbol, "RELIANCE");
  });

  it("summarizes trades with a flattened position", async () => {
    await invokeApp({
      method: "POST",
      url: "/api/trades",
      body: { symbol: "NFLX", side: "BUY", quantity: 10, price: 100 },
    });

    await invokeApp({
      method: "POST",
      url: "/api/trades",
      body: { symbol: "NFLX", side: "SELL", quantity: 10, price: 110 },
    });

    const res = await invokeApp({ method: "GET", url: "/api/trades/summary" });
    assert.equal(res.statusCode, 200);

    const body = res._getJSONData() as {
      data: Array<{
        symbol: string;
        netQuantity: number;
        realizedPnl: number;
        position: string;
        averageEntryPrice: number;
      }>;
    };

    const summary = body.data.find((entry: { symbol: string }) => entry.symbol === "NFLX");
    assert(summary);
    assert.equal(summary.netQuantity, 0);
    assert.equal(summary.position, "FLAT");
    assert.equal(summary.realizedPnl, 100);
    assert.equal(summary.averageEntryPrice, 0);
  });
});
