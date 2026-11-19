import assert from "node:assert/strict";
import express from "express";
import { EventEmitter, once } from "node:events";
import { after, describe, it, mock, beforeEach } from "node:test";
import { createRequest, createResponse, type RequestMethod } from "node-mocks-http";
import errorHandler from "../middleware/errorHandler";
import strategiesRouter from "./strategies";
import type { AppContainer } from "../container";
import { HttpError } from "../utils/HttpError";
import env from "../config/env";

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

// ─── Per-config symbols and daily status (ACH-33) ────────────────────────────

describe("/api/strategies config symbols and daily status", () => {
  const tick = {
    id: "vwap",
    name: "VWAP",
    description: "",
    timeframe: "tick",
    getParamSchema: () => [],
    getDefaultParams: () => ({}),
  };
  const daily = {
    id: "rsi-reversion",
    name: "RSI Mean Reversion",
    description: "",
    timeframe: "1day",
    getParamSchema: () => [{ key: "sizing", label: "Sizing", type: "select" as const, default: "shares", options: [{ value: "shares", label: "s" }, { value: "percent", label: "p" }] }],
    getDefaultParams: () => ({ sizing: "shares" }),
  };
  type Saved = { strategyId: string; enabled: boolean; params: Record<string, unknown>; symbols?: string[] };
  let saved: Saved[];
  let account: { cash: number; equity: number } | undefined;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).user = { userId: "alice" };
    next();
  });
  app.locals.container = {
    tradingEngine: { getStrategies: () => [tick, daily], getStrategy: (id: string) => [tick, daily].find((s) => s.id === id) },
    strategyConfigRepo: {
      getAllConfigs: () => saved,
      getActiveStrategies: () => saved.filter((c) => c.enabled),
      saveConfig: async (_userId: string, c: Saved) => void saved.push(c),
    },
    // Off-hours nothing has ticked yet: the WATCHLIST alone decides what gets prices.
    marketDataService: { getTrackedSymbols: () => [] },
    dailyStrategyRunner: { getStatus: () => ({ scheduled: true, nextRunAt: "2026-11-16T09:45:00.000Z", lastRun: null }) },
    tradingLoopService: { getStatus: () => ({ running: false }) },
    autoTradingService: { getAutoStartStatus: () => ({ enabled: false, manuallyStopped: false }) },
    brokerFactory: { getBroker: async () => ({ name: "paper" }) },
    accountService: { getAccount: async () => account },
  } as unknown as AppContainer;
  app.use("/api/strategies", strategiesRouter);
  app.use(errorHandler);

  const call = async (method: RequestMethod, url: string, body?: unknown) => {
    const req = createRequest({ method, url, headers: { "content-type": "application/json" } });
    if (body !== undefined) req.body = body;
    const res = createResponse({ eventEmitter: EventEmitter });
    const done = once(res, "end");
    app(req, res);
    req.emit("end");
    await done;
    return { status: res.statusCode, body: res._getJSONData() };
  };

  const originalWatchlist = env.watchlist;
  beforeEach(() => {
    saved = [];
    account = undefined;
    env.watchlist = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "icicibank"];
  });
  after(() => {
    env.watchlist = originalWatchlist;
  });

  it("saves a daily strategy's symbols uppercased and de-duplicated", async () => {
    const res = await call("PUT", "/api/strategies/config/rsi-reversion", {
      enabled: true,
      params: { sizing: "percent" },
      symbols: ["reliance", " TCS ", "RELIANCE", "m&m"],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.symbols, ["RELIANCE", "TCS", "M&M"]);
    assert.deepEqual(saved[0].symbols, ["RELIANCE", "TCS", "M&M"]);
  });

  it("ignores symbols for tick strategies, and treats an empty list as 'all tracked'", async () => {
    await call("PUT", "/api/strategies/config/vwap", { enabled: true, symbols: ["TCS"] });
    await call("PUT", "/api/strategies/config/rsi-reversion", { enabled: true, symbols: [] });
    assert.deepEqual(saved.map((c) => c.symbols), [undefined, undefined]);
  });

  it("rejects more than 10 symbols or malformed ones", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `S${i}`);
    assert.equal((await call("PUT", "/api/strategies/config/rsi-reversion", { enabled: true, symbols: eleven })).status, 400);
    assert.equal((await call("PUT", "/api/strategies/config/rsi-reversion", { enabled: true, symbols: ["TCS; DROP"] })).status, 400);
    assert.equal(saved.length, 0);
  });

  it("returns timeframe and symbols with the user's configs", async () => {
    saved = [{ strategyId: "rsi-reversion", enabled: true, params: {}, symbols: ["TCS"] }];
    const res = await call("GET", "/api/strategies/config");
    const rsi = res.body.data.find((s: { strategyId: string }) => s.strategyId === "rsi-reversion");
    assert.equal(rsi.timeframe, "1day");
    assert.deepEqual(rsi.userConfig.symbols, ["TCS"]);
  });

  it("reports the caller's daily setup: trading state, next run, account, symbols not tracked", async () => {
    saved = [
      { strategyId: "rsi-reversion", enabled: true, params: { sizing: "percent" }, symbols: ["TCS", "M&M"] },
      { strategyId: "vwap", enabled: true, params: {} },
    ];
    account = { cash: 5000, equity: 5000 };
    const { status, body } = await call("GET", "/api/strategies/daily-status");
    assert.equal(status, 200);
    assert.equal(body.data.tradingOn, false);
    assert.deepEqual(body.data.autoStart, { enabled: false, manuallyStopped: false });
    assert.equal(body.data.nextRunAt, "2026-11-16T09:45:00.000Z");
    assert.deepEqual(body.data.account, { cash: 5000, equity: 5000 });
    assert.equal(typeof body.data.paperMode, "boolean");
    assert.deepEqual(body.data.strategies, [
      { strategyId: "rsi-reversion", name: "RSI Mean Reversion", symbols: ["TCS", "M&M"], notTracked: ["M&M"], sizing: "percent" },
    ], "only enabled daily strategies");
  });

  it("falls back to every tracked symbol, and to no account when it can't be read", async () => {
    saved = [{ strategyId: "rsi-reversion", enabled: true, params: {} }];
    const { body } = await call("GET", "/api/strategies/daily-status");
    assert.deepEqual(body.data.strategies[0].symbols, ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK"]);
    assert.deepEqual(body.data.strategies[0].notTracked, []);
    assert.equal(body.data.account, null);
  });
});
