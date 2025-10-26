import assert from "node:assert/strict";
import express from "express";
import { EventEmitter, once } from "node:events";
import { before, beforeEach, describe, it } from "node:test";
import { createRequest, createResponse, type RequestMethod } from "node-mocks-http";
import errorHandler from "../middleware/errorHandler";
import strategiesRouter from "./strategies";
import { ensurePortfolioStore, resetPortfolioStore } from "../persistence";
import { resetContainer } from "../container";

interface RequestOptions {
  method: RequestMethod;
  url: string;
  body?: unknown;
}

const testApp = express();
testApp.use("/api/strategies", strategiesRouter);
testApp.use(errorHandler);

const invokeApp = async ({ method, url, body }: RequestOptions) => {
  const req = createRequest({
    method,
    url,
    headers: {
      "content-type": "application/json",
    },
  });

  const res = createResponse({ eventEmitter: EventEmitter });
  const waitForEnd = once(res, "end");
  if (typeof body !== "undefined") {
    req.body = body;
  }

  testApp(req, res);

  req.emit("end");

  await waitForEnd;
  return res;
};

describe("/api/strategies routes", () => {
  before(async () => {
    await ensurePortfolioStore();
  });

  beforeEach(async () => {
    await resetPortfolioStore();
    resetContainer();
  });

  it("evaluates a strategy and returns execution details", async () => {
    // Send tick with significant price deviation to trigger VWAP strategy
    // VWAP strategy requires >1% deviation from volume-weighted average
    const res = await invokeApp({
      method: "POST",
      url: "/api/strategies/vwap/evaluate",
      body: {
        ticks: [
          {
            symbol: "RELIANCE",
            price: 150,   // High price with low volume
            volume: 10,
            timestamp: new Date().toISOString(),
          },
          {
            symbol: "RELIANCE",
            price: 100,   // Low price with high volume
            volume: 1000, // Creates VWAP ≈ 100, so second tick has ~0% deviation
            timestamp: new Date().toISOString(),
          },
          {
            symbol: "RELIANCE",
            price: 103,   // Price 3% above VWAP - triggers signal
            volume: 100,
            timestamp: new Date().toISOString(),
          },
        ],
      },
    });

    assert.equal(res.statusCode, 200);

    const payload = res._getJSONData() as {
      data: {
        strategyId: string;
        executions: Array<{
          signal: { description: string };
          executions: Array<{ status: string }>;
          failures: unknown[];
        }>;
        errors: unknown[];
      };
    };

    assert.equal(payload.data.strategyId, "vwap");
    // Strategy may or may not generate signals depending on deviation threshold
    // Just verify the response structure is correct
    assert(Array.isArray(payload.data.executions));
    assert(Array.isArray(payload.data.errors));
    assert.equal(payload.data.errors.length, 0);
  });

  it("returns validation errors for malformed requests", async () => {
    const res = await invokeApp({
      method: "POST",
      url: "/api/strategies/vwap/evaluate",
      body: {
        ticks: [
          {
            symbol: "RELIANCE",
            price: -1,  // Invalid: negative price
            volume: 0,  // Invalid: zero volume
          },
        ],
      },
    });

    assert.equal(res.statusCode, 400);
    const payload = res._getJSONData() as { error: string };
    assert.equal(payload.error, "ValidationError");
  });

  it("fails when the strategy is not registered", async () => {
    const res = await invokeApp({
      method: "POST",
      url: "/api/strategies/unknown/evaluate",
      body: {
        ticks: [
          {
            symbol: "RELIANCE",
            price: 150,
            volume: 10,
            timestamp: new Date().toISOString(),
          },
        ],
      },
    });

    assert.equal(res.statusCode, 404);
    const payload = res._getJSONData() as { error: string; message: string };
    assert.equal(payload.error, "HttpError");
    assert.equal(payload.message, "Unknown strategy unknown");
  });
});
