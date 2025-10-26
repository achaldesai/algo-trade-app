import assert from "node:assert/strict";
import express from "express";
import { EventEmitter, once } from "node:events";
import { before, beforeEach, describe, it } from "node:test";
import { createRequest, createResponse, type RequestMethod } from "node-mocks-http";
import errorHandler from "../middleware/errorHandler";
import marketDataRouter from "./marketData";
import { resolveMarketDataService, resetContainer } from "../container";
import { ensurePortfolioStore, resetPortfolioStore } from "../persistence";

interface RequestOptions {
  method: RequestMethod;
  url: string;
  body?: unknown;
}

const testApp = express();
testApp.use("/api/market-data", marketDataRouter);
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

describe("/api/market-data routes", () => {
  before(async () => {
    await ensurePortfolioStore();
  });

  beforeEach(async () => {
    await resetPortfolioStore();
    resetContainer();
  });

  it("stores ticks through the batch ingestion endpoint", async () => {
    const res = await invokeApp({
      method: "POST",
      url: "/api/market-data/batch",
      body: {
        ticks: [
          { symbol: "aapl", price: 150.1234, volume: 10.55, timestamp: "2023-01-01T10:00:00.000Z" },
          { symbol: "msft", price: 300.9876, volume: 20.45, timestamp: "2023-01-01T11:00:00.000Z" },
        ],
      },
    });

    assert.equal(res.statusCode, 201);
    const payload = res._getJSONData() as {
      data: Array<{ symbol: string; price: number; volume: number; timestamp: string }>;
    };

    assert.equal(payload.data.length, 2);
    const first = payload.data.find((tick) => tick.symbol === "AAPL");
    const second = payload.data.find((tick) => tick.symbol === "MSFT");
    assert(first);
    assert(second);
    assert.equal(first.price, 150.1234);
    assert.equal(first.volume, 10.55);
    assert.equal(first.timestamp, "2023-01-01T10:00:00.000Z");
    assert.equal(second.price, 300.9876);
    assert.equal(second.volume, 20.45);

    const snapshotRes = await invokeApp({ method: "GET", url: "/api/market-data?symbol=AAPL&symbol=MSFT" });
    assert.equal(snapshotRes.statusCode, 200);

    const snapshot = snapshotRes._getJSONData() as {
      data: { ticks: Array<{ symbol: string; price: number; volume: number; timestamp: string }> };
    };

    const symbols = snapshot.data.ticks.map((tick) => tick.symbol);
    assert.deepEqual(symbols.sort(), ["AAPL", "MSFT"]);

    const marketDataService = resolveMarketDataService();
    const cached = marketDataService.getSnapshot(["AAPL", "MSFT"]);
    assert.equal(cached.ticks.length, 2);
  });
});
