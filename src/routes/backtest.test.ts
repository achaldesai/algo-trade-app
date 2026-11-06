import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import backtestRouter from "./backtest";
import errorHandler from "../middleware/errorHandler";
import env from "../config/env";
import BacktestService, { type BacktestRun } from "../services/BacktestService";
import MovingAverageCrossoverStrategy from "../strategies/MovingAverageCrossoverStrategy";
import VWAPStrategy from "../strategies/VWAPStrategy";
import type BaseStrategy from "../strategies/BaseStrategy";
import type { AppContainer } from "../container";
import type { BacktestRepo } from "../db/repositories/BacktestRepo";
import type { HistoricalCandle } from "../types";
import type TradingEngine from "../services/TradingEngine";
import type { HistoricalDataService } from "../services/HistoricalDataService";

// No network: a stub history provider and an in-memory repo behind the real service.

const SECRET = "test-secret";
const DAY = 86_400_000;
const closes = [...Array(10).fill(100), 104, 108, 112, 116, 120, 118, 110, 100, 92, 85, 80];
const bars: HistoricalCandle[] = closes.map((c, i) => ({
  symbol: "TCS",
  open: c,
  high: c,
  low: c,
  close: c,
  volume: 1,
  timestamp: new Date(Date.UTC(2025, 0, 1) + i * DAY),
}));

const store = new Map<string, BacktestRun>();
const repo = {
  save: async (run: BacktestRun) => void store.set(`${run.userId}:${run.id}`, run),
  list: (userId: string) => [...store.values()].filter((r) => r.userId === userId),
  get: (userId: string, id: string) => store.get(`${userId}:${id}`),
  delete: async (userId: string, id: string) => store.delete(`${userId}:${id}`),
} as unknown as BacktestRepo;

const strategies = new Map<string, BaseStrategy>([
  ["vwap", new VWAPStrategy()],
  ["ma-crossover", new MovingAverageCrossoverStrategy()],
]);
const backtestService = new BacktestService(
  { getStrategy: (id: string) => strategies.get(id) } as unknown as TradingEngine,
  { getHistoricalData: async () => bars } as unknown as HistoricalDataService,
  repo,
);

const users = new Set(["alice", "bob"]);
const container = {
  backtestService,
  userRepo: { findUserById: (id: string) => (users.has(id) ? { id } : undefined) },
} as unknown as AppContainer;

const tokens = {
  alice: jwt.sign({ userId: "alice", role: "USER" }, SECRET),
  bob: jwt.sign({ userId: "bob", role: "USER" }, SECRET),
};

const validBody = {
  strategyId: "ma-crossover",
  symbols: ["TCS"],
  from: "2025-01-10",
  to: "2025-01-21",
  params: { fastPeriod: 3, slowPeriod: 5 },
};

describe("/api/backtest routes", () => {
  let server: Server;
  let base: string;
  const originalKey = env.adminApiKey;

  const call = (method: string, url: string, token?: string, body?: unknown) =>
    fetch(`${base}/api/backtest${url}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });

  before(async () => {
    env.adminApiKey = SECRET;
    const app = express();
    app.use(express.json());
    app.locals.container = container;
    app.use("/api/backtest", backtestRouter);
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    env.adminApiKey = originalKey;
    server.close();
  });

  it("requires a user token", async () => {
    assert.equal((await call("GET", "/")).status, 401);
  });

  it("runs, lists, fetches and deletes a backtest for the caller only", async () => {
    let res = await call("POST", "/", tokens.alice, validBody);
    assert.equal(res.status, 201);
    const run = (await res.json()).data as BacktestRun;
    assert.equal(run.initialCapital, 1_000_000, "default capital");
    assert.equal(run.costBps, 10, "default costs");
    assert.equal(run.to, "2025-01-21", "inclusive end date");
    assert.equal(run.equityCurve.at(-1)!.date, "2025-01-21");
    assert.ok(run.trades.length > 0);

    res = await call("GET", "/", tokens.alice);
    assert.deepEqual(((await res.json()).data as BacktestRun[]).map((r) => r.id), [run.id]);
    assert.equal((await call("GET", `/${run.id}`, tokens.alice)).status, 200);

    assert.equal((await call("GET", `/${run.id}`, tokens.bob)).status, 404);
    assert.equal((await call("DELETE", `/${run.id}`, tokens.bob)).status, 404);
    assert.deepEqual((await (await call("GET", "/", tokens.bob)).json()).data, []);

    assert.equal((await call("DELETE", `/${run.id}`, tokens.alice)).status, 204);
    assert.equal((await call("GET", `/${run.id}`, tokens.alice)).status, 404);
  });

  it("returns 400 for invalid bodies and tick strategies", async () => {
    for (const body of [
      { ...validBody, from: "10/01/2025" },
      { ...validBody, symbols: [] },
      { ...validBody, initialCapital: -5 },
      { ...validBody, strategyId: "vwap" },
      { ...validBody, from: "2025-01-21", to: "2025-01-10" },
    ]) {
      const res = await call("POST", "/", tokens.alice, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });
});
