import assert from "node:assert/strict";
import express from "express";
import { EventEmitter, once } from "node:events";
import { describe, it, mock, beforeEach } from "node:test";
import { createRequest, createResponse, type RequestMethod } from "node-mocks-http";
import errorHandler from "../middleware/errorHandler";
import stocksRouter from "./stocks";
import type { AppContainer } from "../container";

interface RequestOptions {
  method: RequestMethod;
  url: string;
  body?: unknown;
}

const mockStocks: Array<{ symbol: string; name: string; createdAt: Date }> = [];

const mockPortfolioService = {
  listStocks: mock.fn(() => mockStocks),
  addStock: mock.fn(async (_userId: string, input: { symbol: string; name: string }) => {
    const stock = { ...input, createdAt: new Date() };
    mockStocks.push(stock);
    return stock;
  }),
};

const testApp = express();
testApp.use(express.json());
testApp.use((req, _res, next) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).user = { userId: "test-user" };
  next();
});
testApp.locals.container = { portfolioService: mockPortfolioService } as unknown as AppContainer;
testApp.use("/api/stocks", stocksRouter);
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

describe("/api/stocks routes", () => {
  beforeEach(() => {
    mockStocks.length = 0;
    mockPortfolioService.listStocks.mock.resetCalls();
    mockPortfolioService.addStock.mock.resetCalls();
  });

  it("lists stocks", async () => {
    const res = await invokeApp({ method: "GET", url: "/api/stocks" });
    assert.equal(res.statusCode, 200);

    const payload = res._getJSONData() as { data: Array<{ symbol: string }> };
    assert(Array.isArray(payload.data));
  });

  it("rejects invalid payloads", async () => {
    const res = await invokeApp({
      method: "POST",
      url: "/api/stocks",
      body: { symbol: "   ", name: "" },
    });

    assert.equal(res.statusCode, 400);
    const payload = res._getJSONData() as { error: string };
    assert.equal(payload.error, "ValidationError");
  });

  it("creates a new stock", async () => {
    const uniqueSymbol = `TST${Date.now()}`;
    const res = await invokeApp({
      method: "POST",
      url: "/api/stocks",
      body: { symbol: uniqueSymbol, name: "Test Instrument" },
    });

    assert.equal(res.statusCode, 201);
    const payload = res._getJSONData() as { data: { symbol: string; name: string } };
    assert.equal(payload.data.symbol, uniqueSymbol);
    assert.equal(payload.data.name, "Test Instrument");

    const created = mockStocks.find((stock: { symbol: string }) => stock.symbol === uniqueSymbol);
    assert(created);
  });
});
