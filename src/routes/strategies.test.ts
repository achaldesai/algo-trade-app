import assert from "node:assert/strict";
import express from "express";
import { EventEmitter, once } from "node:events";
import { describe, it, mock, beforeEach } from "node:test";
import { createRequest, createResponse, type RequestMethod } from "node-mocks-http";
import errorHandler from "../middleware/errorHandler";
import strategiesRouter from "./strategies";
import type { AppContainer } from "../container";
import { HttpError } from "../utils/HttpError";

interface RequestOptions {
  method: RequestMethod;
  url: string;
  body?: unknown;
}

const mockStrategies = [
  {
    id: "vwap",
    name: "VWAP Mean Reversion",
    description: "Buy low / sell high relative to VWAP",
    getParamSchema: () => [
      { key: "threshold", label: "Threshold", type: "number" as const, default: 0.01, min: 0.001, max: 0.1 },
      { key: "orderSize", label: "Order Size", type: "number" as const, default: 10, min: 1, max: 1000 },
    ],
    getDefaultParams: () => ({ threshold: 0.01, orderSize: 10 }),
  },
];

const mockTradingEngine = {
  getStrategies: mock.fn(() => mockStrategies),
  getStrategy: mock.fn((id: string) => mockStrategies.find((s) => s.id === id) ?? undefined),
  evaluate: mock.fn(async (strategyId: string, _userId: string) => {
    if (!mockStrategies.find((s) => s.id === strategyId)) {
      throw new HttpError(404, `Unknown strategy ${strategyId}`);
    }
    return {
      strategyId,
      executions: [],
      errors: [],
    };
  }),
};

const mockMarketDataService = {
  updateTick: mock.fn((tick: { symbol: string; price: number; volume: number }) => ({
    ...tick,
    symbol: tick.symbol.toUpperCase(),
    timestamp: new Date(),
  })),
};

const mockStrategyConfigRepo = {
  getConfig: mock.fn(() => null),
  getAllConfigs: mock.fn(() => []),
  getActiveStrategies: mock.fn(() => []),
  saveConfig: mock.fn(async () => { }),
  deleteConfig: mock.fn(async () => true),
};

const testApp = express();
testApp.use(express.json());
testApp.use((req, _res, next) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).user = { userId: "test-user" };
  next();
});
testApp.locals.container = {
  tradingEngine: mockTradingEngine,
  marketDataService: mockMarketDataService,
  strategyConfigRepo: mockStrategyConfigRepo,
} as unknown as AppContainer;
testApp.use("/api/strategies", strategiesRouter);
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

describe("/api/strategies routes", () => {
  beforeEach(() => {
    mockTradingEngine.getStrategies.mock.resetCalls();
    mockTradingEngine.getStrategy.mock.resetCalls();
    mockTradingEngine.evaluate.mock.resetCalls();
    mockMarketDataService.updateTick.mock.resetCalls();
    mockStrategyConfigRepo.getConfig.mock.resetCalls();
  });

  it("evaluates a strategy and returns execution details", async () => {
    const res = await invokeApp({
      method: "POST",
      url: "/api/strategies/vwap/evaluate",
      body: {
        ticks: [
          { symbol: "RELIANCE", price: 150, volume: 10, timestamp: new Date().toISOString() },
        ],
      },
    });

    assert.equal(res.statusCode, 200);
    const payload = res._getJSONData() as {
      data: { strategyId: string; executions: unknown[]; errors: unknown[] };
    };

    assert.equal(payload.data.strategyId, "vwap");
    assert(Array.isArray(payload.data.executions));
    assert(Array.isArray(payload.data.errors));
    assert.equal(payload.data.errors.length, 0);
  });

  it("returns validation errors for malformed requests", async () => {
    const res = await invokeApp({
      method: "POST",
      url: "/api/strategies/vwap/evaluate",
      body: {
        ticks: [{ symbol: "RELIANCE", price: -1, volume: 0 }],
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
        ticks: [{ symbol: "RELIANCE", price: 150, volume: 10, timestamp: new Date().toISOString() }],
      },
    });

    assert.equal(res.statusCode, 404);
    const payload = res._getJSONData() as { error: string; message: string };
    assert.equal(payload.error, "HttpError");
    assert.equal(payload.message, "Unknown strategy unknown");
  });

  it("lists strategies with param schemas", async () => {
    const res = await invokeApp({
      method: "GET",
      url: "/api/strategies",
    });

    assert.equal(res.statusCode, 200);
    const payload = res._getJSONData() as {
      data: { id: string; paramSchema: unknown[]; defaultParams: Record<string, unknown> }[];
    };
    assert.equal(payload.data.length, 1);
    assert.equal(payload.data[0].id, "vwap");
    assert(Array.isArray(payload.data[0].paramSchema));
    assert.equal(payload.data[0].paramSchema.length, 2);
    assert.deepEqual(payload.data[0].defaultParams, { threshold: 0.01, orderSize: 10 });
  });
});
