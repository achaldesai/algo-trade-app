import assert from "node:assert/strict";
import { describe, it } from "node:test";
import BaseStrategy, { type StrategyContext, type StrategyTimeframe } from "../strategies/BaseStrategy";
import MovingAverageCrossoverStrategy from "../strategies/MovingAverageCrossoverStrategy";
import VWAPStrategy from "../strategies/VWAPStrategy";
import { BacktestService, computeMetrics, simulate, type BacktestRun } from "./BacktestService";
import { DelistedSymbolError, type HistoricalDataService } from "./HistoricalDataService";
import type TradingEngine from "./TradingEngine";
import type { BacktestRepo } from "../db/repositories/BacktestRepo";
import type { BrokerOrderRequest, HistoricalCandle, StrategySignal } from "../types";
import { HttpError } from "../utils/HttpError";

const DAY = 86_400_000;
const D0 = Date.UTC(2025, 0, 6);
const date = (i: number) => new Date(D0 + i * DAY);
const key = (i: number) => date(i).toISOString().slice(0, 10);

function candles(symbol: string, ohlc: [number, number][], startDay = 0): HistoricalCandle[] {
  return ohlc.map(([open, close], i) => ({
    symbol,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1000,
    timestamp: date(startDay + i),
  }));
}

/** Emits pre-scripted orders on given bar dates and records what it was shown. */
class ScriptedStrategy extends BaseStrategy {
  override readonly timeframe: StrategyTimeframe = "1day";
  readonly seen: StrategyContext[] = [];
  constructor(private readonly script: Record<string, BrokerOrderRequest[]>, private readonly warmup = 0) {
    super("scripted", "Scripted", "test double");
  }
  getParamSchema() {
    return [];
  }
  getDefaultParams() {
    return {};
  }
  override getWarmupBars() {
    return this.warmup;
  }
  async generateSignals(ctx: StrategyContext): Promise<StrategySignal[]> {
    this.seen.push(ctx);
    const orders = this.script[ctx.market.asOf.toISOString().slice(0, 10)] ?? [];
    return orders.length ? [{ strategyId: this.id, description: "", requestedOrders: orders }] : [];
  }
}

const order = (side: "BUY" | "SELL", quantity: number): BrokerOrderRequest => ({
  symbol: "AAA",
  side,
  quantity,
  type: "MARKET",
});

// D0..D4 (open, close)
const AAA = candles("AAA", [
  [100, 100],
  [102, 104],
  [105, 103],
  [101, 99],
  [98, 100],
]);

describe("simulate", () => {
  it("fills at the next day's open and tracks cash, equity and P&L (no costs)", async () => {
    const strategy = new ScriptedStrategy({
      [key(0)]: [order("BUY", 10)],
      [key(2)]: [order("SELL", 10)],
      [key(3)]: [order("SELL", 5)],
    });
    const result = await simulate({
      strategy,
      params: {},
      candles: { AAA },
      from: date(0),
      to: date(4),
      initialCapital: 10_000,
      costBps: 0,
      slippageBps: 0,
    });

    assert.deepEqual(result.trades, [
      { date: key(1), symbol: "AAA", side: "BUY", quantity: 10, price: 102, cost: 0 },
      { date: key(3), symbol: "AAA", side: "SELL", quantity: 10, price: 101, cost: 0, pnl: -10 },
    ]);
    assert.deepEqual(
      result.equityCurve.map((p) => p.equity),
      [10_000, 10_020, 10_010, 9_990, 9_990],
    );
    assert.deepEqual(result.rejections, [
      { date: key(4), symbol: "AAA", side: "SELL", quantity: 5, reason: "No position to sell (long-only)" },
    ]);
    assert.equal(result.metrics.maxDrawdownPct, 0.3); // (10020 - 9990) / 10020
    assert.equal(result.metrics.totalReturnPct, -0.1);
    assert.equal(result.metrics.benchmarkReturnPct, 0); // first open 100, last close 100
    assert.equal(result.metrics.roundTrips, 1);
    assert.equal(result.metrics.winRatePct, 0);
    // Invested at closes: 0, 1040/10020, 1030/10010, 0, 0 -> mean 4.13%
    assert.equal(result.metrics.exposurePct, 4.13);
  });

  it("charges slippage against the trader and costs on both legs", async () => {
    const strategy = new ScriptedStrategy({ [key(0)]: [order("BUY", 10)], [key(2)]: [order("SELL", 10)] });
    const { trades } = await simulate({
      strategy,
      params: {},
      candles: { AAA },
      from: date(0),
      to: date(4),
      initialCapital: 10_000,
      costBps: 10,
      slippageBps: 5,
    });
    // Buy: 102 * 1.0005 = 102.051, cost 1.02. Sell: 101 * 0.9995 = 100.9495, cost 1.01.
    // P&L = 1009.495 - 1.009495 - (1020.51 + 1.02051) = -13.045
    assert.deepEqual(
      trades.map(({ price, cost, pnl }) => ({ price, cost, pnl })),
      [
        { price: 102.051, cost: 1.02, pnl: undefined },
        { price: 100.9495, cost: 1.01, pnl: -13.05 },
      ],
    );
  });

  it("rejects buys that exceed available cash", async () => {
    const strategy = new ScriptedStrategy({ [key(0)]: [order("BUY", 10)] });
    const result = await simulate({
      strategy,
      params: {},
      candles: { AAA },
      from: date(0),
      to: date(4),
      initialCapital: 500,
      costBps: 0,
      slippageBps: 0,
    });
    assert.deepEqual(result.trades, []);
    assert.match(result.rejections[0].reason, /Insufficient cash/);
    assert.ok(result.equityCurve.every((p) => p.equity === 500));
  });

  it("never shows the strategy a future bar, and passes warm-up history from before `from`", async () => {
    const history = candles("AAA", [[90, 90], [91, 91], [92, 92]], -3);
    const strategy = new ScriptedStrategy({}, 2);
    const result = await simulate({
      strategy,
      params: {},
      candles: { AAA: [...history, ...AAA] },
      from: date(0),
      to: date(4),
      initialCapital: 1000,
      costBps: 0,
    });

    assert.equal(result.equityCurve[0].date, key(0), "curve starts at `from`");
    assert.equal(strategy.seen.length, 4, "no evaluation after the last day");
    for (const ctx of strategy.seen) {
      const bars = ctx.bars!.AAA;
      assert.equal(bars.at(-1)!.timestamp.getTime(), ctx.market.asOf.getTime());
      assert.equal(bars.length, 3, "window = warm-up + 1");
    }
    assert.deepEqual(strategy.seen[0].bars!.AAA.map((b) => b.close), [91, 92, 100]);
  });
});

describe("computeMetrics", () => {
  it("computes CAGR, Sharpe, win rate and profit factor", () => {
    const curve = [
      { date: "2024-01-01", equity: 100 },
      { date: "2025-01-01", equity: 110 },
    ];
    const trades = [
      { date: "x", symbol: "A", side: "SELL" as const, quantity: 1, price: 1, cost: 0, pnl: 30 },
      { date: "x", symbol: "A", side: "SELL" as const, quantity: 1, price: 1, cost: 0, pnl: -10 },
      { date: "x", symbol: "A", side: "BUY" as const, quantity: 1, price: 1, cost: 0 },
    ];
    const m = computeMetrics(100, curve, trades, 0.05);
    assert.equal(m.totalReturnPct, 10);
    assert.ok(Math.abs(m.cagrPct - 9.99) < 0.05, `cagr ${m.cagrPct}`);
    assert.equal(m.roundTrips, 2);
    assert.equal(m.winRatePct, 50);
    assert.equal(m.profitFactor, 3);
    assert.equal(m.benchmarkReturnPct, 5);
    // Daily returns [0, 0.1]: mean 0.05, sd 0.0707 -> 0.707 * sqrt(252)
    assert.equal(m.sharpe, 11.22);
    assert.equal(computeMetrics(100, [{ date: "2024-01-01", equity: 100 }, { date: "2024-01-02", equity: 100 }], [], 0).sharpe, null);
  });
});

// ─── Service ─────────────────────────────────────────────────────────────────

function makeService(data: Record<string, HistoricalCandle[]>) {
  const strategies = new Map<string, BaseStrategy>([
    ["vwap", new VWAPStrategy()],
    ["ma-crossover", new MovingAverageCrossoverStrategy()],
  ]);
  const saved: BacktestRun[] = [];
  const service = new BacktestService(
    { getStrategy: (id: string) => strategies.get(id) } as unknown as TradingEngine,
    {
      getHistoricalData: async ({ symbol }: { symbol: string }) => {
        if (symbol === "GONE") throw new DelistedSymbolError(symbol);
        if (symbol === "BROKEN") throw new Error("socket hang up");
        return data[symbol] ?? [];
      },
    } as unknown as HistoricalDataService,
    { save: async (run: BacktestRun) => void saved.push(run) } as unknown as BacktestRepo,
  );
  return { service, saved };
}

// Flat, then a rally (fast SMA crosses up), then a sell-off (crosses down).
const closes = [...Array(10).fill(100), 104, 108, 112, 116, 120, 118, 110, 100, 92, 85, 80];
const TREND = candles("TREND", closes.map((c) => [c, c] as [number, number]), -9);

const base = {
  strategyId: "ma-crossover",
  symbols: ["trend"],
  from: date(0),
  to: date(11),
  params: { fastPeriod: 3, slowPeriod: 5, orderSize: 10 },
  initialCapital: 100_000,
};

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof HttpError ? `${e.statusCode} ${e.message}` : String(e);
  }
};

describe("BacktestService.run", () => {
  it("runs a real strategy end to end and saves the run", async () => {
    const { service, saved } = makeService({ TREND });
    const run = await service.run("u1", base);

    assert.deepEqual(run.symbols, ["TREND"]);
    // SMA3 crosses above SMA5 on day 1 (close 104) -> fill day 2 open (108).
    // SMA3 109.3 < SMA5 112.8 on day 8 -> fill day 9 open (92). Crossovers lag.
    assert.deepEqual(
      run.trades.map(({ date, side }) => ({ date, side })),
      [
        { date: key(2), side: "BUY" },
        { date: key(9), side: "SELL" },
      ],
    );
    assert.ok(run.trades[1].pnl! < -160, "(92 - 108) * 10 minus costs");
    assert.equal(run.params.maType, "sma", "defaults merged");
    assert.equal(run.equityCurve.length, 12);
    assert.equal(run.from, key(0));
    assert.deepEqual(saved.map((r) => r.id), [run.id]);
  });

  it("refuses tick strategies such as VWAP", async () => {
    const { service } = makeService({ TREND });
    assert.match(await status(service.run("u1", { ...base, strategyId: "vwap" })), /^400 .*live ticks/);
  });

  it("validates symbols, dates and params", async () => {
    const { service } = makeService({ TREND });
    const many = Array.from({ length: 11 }, (_, i) => `S${i}`);
    assert.match(await status(service.run("u1", { ...base, symbols: many })), /^400 At most 10/);
    assert.match(await status(service.run("u1", { ...base, from: date(5), to: date(5) })), /^400 'from'/);
    assert.match(await status(service.run("u1", { ...base, to: new Date(Date.UTC(2036, 0, 1)) })), /^400 .*10 years/);
    assert.match(await status(service.run("u1", { ...base, params: { fastPeriod: 500 } })), /^400 Parameter 'fastPeriod'/);
    assert.match(
      await status(service.run("u1", { ...base, params: { fastPeriod: 9, slowPeriod: 5 } })),
      /^400 Strategy rejected/,
    );
    assert.match(await status(service.run("u1", { ...base, strategyId: "nope" })), /^404/);
  });

  it("skips delisted symbols with a warning, and 422s when nothing is left", async () => {
    const { service } = makeService({ TREND });
    const run = await service.run("u1", { ...base, symbols: ["TREND", "GONE"] });
    assert.deepEqual(run.symbols, ["TREND", "GONE"]);
    assert.match(run.warnings[0], /^GONE: no historical data/);

    assert.match(await status(service.run("u1", { ...base, symbols: ["GONE"] })), /^422/);
    assert.match(await status(service.run("u1", { ...base, symbols: ["BROKEN"] })), /^502 .*socket hang up/);
  });
});
