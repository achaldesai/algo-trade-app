import assert from "node:assert/strict";
import express from "express";
import { EventEmitter, once } from "node:events";
import { describe, it } from "node:test";
import { createRequest, createResponse } from "node-mocks-http";
import errorHandler from "../middleware/errorHandler";
import strategiesRouter from "./strategies";

interface RequestOptions {
  method: string;
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

  testApp.handle(req, res);

  req.emit("end");

  await waitForEnd;
  return res;
};

describe("/api/strategies routes", () => {
  it("evaluates a strategy and returns execution details", async () => {
    const res = await invokeApp({
      method: "POST",
      url: "/api/strategies/vwap/evaluate",
      body: {
        ticks: [
          {
            symbol: "AAPL",
            price: 200,
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
    const firstExecution = payload.data.executions[0];
    assert(firstExecution);
    assert(firstExecution.signal.description.includes("AAPL"));
    assert(firstExecution.executions[0].status);
    assert(Array.isArray(firstExecution.failures));
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
            symbol: "AAPL",
            price: -1,
            volume: 0,
          },
        ],
      },
    });

    assert.equal(res.statusCode, 400);
    const payload = res._getJSONData() as { error: string };
    assert.equal(payload.error, "ValidationError");
  });
});
