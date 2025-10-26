import assert from "node:assert/strict";
import express from "express";
import { EventEmitter, once } from "node:events";
import { before, beforeEach, describe, it } from "node:test";
import { createRequest, createResponse, type RequestMethod } from "node-mocks-http";
import errorHandler from "../middleware/errorHandler";
import tradesRouter from "./trades";
import { resolvePortfolioService, resetContainer } from "../container";
import { ensurePortfolioStore, resetPortfolioStore } from "../persistence";

interface RequestOptions {
  method: RequestMethod;
  url: string;
  body?: unknown;
}

const testApp = express();
testApp.use("/api/trades", tradesRouter);
testApp.use(errorHandler);

const invokeApp = async ({ method, url, body }: RequestOptions) => {
  const req = createRequest({
    method,
    url,
    headers: {
      "content-type": "application/json",
    },
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
  before(async () => {
    await ensurePortfolioStore();
  });

  beforeEach(async () => {
    await resetPortfolioStore();
    resetContainer();
  });

  it("creates a trade for an existing stock", async () => {
    // First create the stock
    const portfolioService = resolvePortfolioService();
    await portfolioService.addStock({ symbol: "RELIANCE", name: "Reliance Industries" });

    const payload = {
      symbol: "RELIANCE",
      side: "BUY",
      quantity: 5,
      price: 2500.50,
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
    assert.equal(body.data.price, 2500.50);
    assert.equal(body.data.notes, "Test trade");
    assert.equal(body.data.executedAt, "2023-01-01T10:00:00.000Z");

    const trades = await portfolioService.listTrades();
    const stored = trades.find((trade) => trade.id === body.data.id);
    assert(stored);
    assert.equal(stored.symbol, "RELIANCE");
  });

  it("rejects trade creation when the stock symbol is unknown", async () => {
    const res = await invokeApp({
      method: "POST",
      url: "/api/trades",
      body: {
        symbol: "UNKN",
        side: "SELL",
        quantity: 1,
        price: 300,
      },
    });

    assert.equal(res.statusCode, 404);
    const body = res._getJSONData() as { error: string; message: string };
    assert.equal(body.error, "HttpError");
    assert.equal(body.message, "Unknown stock symbol UNKN");
  });

  it("summarizes trades with a flattened position", async () => {
    const portfolioService = resolvePortfolioService();
    await portfolioService.addStock({ symbol: "NFLX", name: "Netflix" });

    await invokeApp({
      method: "POST",
      url: "/api/trades",
      body: {
        symbol: "NFLX",
        side: "BUY",
        quantity: 10,
        price: 100,
      },
    });

    await invokeApp({
      method: "POST",
      url: "/api/trades",
      body: {
        symbol: "NFLX",
        side: "SELL",
        quantity: 10,
        price: 110,
      },
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

    const summary = body.data.find((entry) => entry.symbol === "NFLX");
    assert(summary);
    assert.equal(summary.netQuantity, 0);
    assert.equal(summary.position, "FLAT");
    assert.equal(summary.realizedPnl, 100);
    assert.equal(summary.averageEntryPrice, 0);
  });
});
