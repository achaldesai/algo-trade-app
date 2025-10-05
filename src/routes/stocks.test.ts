import assert from "node:assert/strict";
import express from "express";
import { EventEmitter, once } from "node:events";
import { describe, it } from "node:test";
import { createRequest, createResponse } from "node-mocks-http";
import { portfolioService } from "../container";
import errorHandler from "../middleware/errorHandler";
import stocksRouter from "./stocks";

interface RequestOptions {
  method: string;
  url: string;
  body?: unknown;
}

const testApp = express();
testApp.use("/api/stocks", stocksRouter);
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
  testApp.handle(req, res);

  req.emit("end");

  await waitForEnd;
  return res;
};

describe("/api/stocks routes", () => {
  it("lists seeded stocks", async () => {
    const res = await invokeApp({ method: "GET", url: "/api/stocks" });
    assert.equal(res.statusCode, 200);

    const payload = res._getJSONData() as { data: Array<{ symbol: string }> };
    const symbols = payload.data.map((stock) => stock.symbol);
    assert(symbols.includes("AAPL"));
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

    const created = portfolioService.listStocks().find((stock) => stock.symbol === uniqueSymbol);
    assert(created);
  });
});
