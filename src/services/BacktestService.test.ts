import assert from "node:assert/strict";
import { describe, it } from "node:test";
import BaseStrategy, { type StrategyContext, type StrategyTimeframe } from "../strategies/BaseStrategy";
import MovingAverageCrossoverStrategy from "../strategies/MovingAverageCrossoverStrategy";
import RsiMeanReversionStrategy from "../strategies/RsiMeanReversionStrategy";
import VWAPStrategy from "../strategies/VWAPStrategy";
import { BacktestService, computeMetrics, fdMetrics, simulate, xirr, type BacktestRun } from "./BacktestService";
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

  it("shows the strategy the account's cash and equity at each signal close", async () => {
    const strategy = new ScriptedStrategy({ [key(0)]: [order("BUY", 10)] });
    await simulate({
      strategy,
      params: {},
      candles: { AAA },
      from: date(0),
      to: date(4),
      initialCapital: 10_000,
      costBps: 0,
      slippageBps: 0,
    });
    assert.deepEqual(strategy.seen[0].account, { cash: 10_000, equity: 10_000 });
    // Bought 10 @ 102 on day 1; day 1 closes at 104.
    assert.deepEqual(strategy.seen[1].account, { cash: 8_980, equity: 10_020 });
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

describe("monthly contributions", () => {
  // Flat ₹100 prices across a month boundary: Jan 30, Jan 31, Feb 3, Feb 4, Mar 2.
  const days = ["2025-01-30", "2025-01-31", "2025-02-03", "2025-02-04", "2025-03-03"];
  const flat = (symbol: string, prices = days.map(() => 100)) =>
    days.map((d, i) => ({
      symbol,
      open: prices[i],
      high: prices[i],
      low: prices[i],
      close: prices[i],
      volume: 1,
      timestamp: new Date(`${d}T00:00:00.000Z`),
    }));
  const sim = (strategy: BaseStrategy, candles: Record<string, HistoricalCandle[]>, initialCapital = 1000) =>
    simulate({
      strategy,
      params: {},
      candles,
      from: new Date("2025-01-30"),
      to: new Date("2025-03-03"),
      initialCapital,
      monthlyContribution: 1000,
      costBps: 0,
      slippageBps: 0,
    });

  it("credits a deposit on the first trading day of each new month, and doesn't count it as profit", async () => {
    const result = await sim(new ScriptedStrategy({}), { AAA: flat("AAA") });

    assert.deepEqual(result.contributions, [
      { date: "2025-02-03", amount: 1000 },
      { date: "2025-03-03", amount: 1000 },
    ]);
    assert.deepEqual(
      result.equityCurve.map((p) => [p.equity, p.contributed]),
      [[1000, 1000], [1000, 1000], [2000, 2000], [2000, 2000], [3000, 3000]],
    );
    const m = result.metrics;
    assert.equal(m.totalContributed, 3000);
    assert.equal(m.profit, 0);
    assert.equal(m.totalReturnPct, 0);
    assert.equal(m.cagrPct, 0, "time-weighted: deposits are not growth");
    assert.equal(m.maxDrawdownPct, 0);
    assert.equal(m.moneyWeightedReturnPct, 0);
    assert.equal(m.benchmarkProfit, 0, "flat prices: the monthly benchmark breaks even too");
  });

  it("credits the deposit before that day's fills, so a buy can use it", async () => {
    // Signal on Jan 31 for 15 shares (₹1,500); only ₹1,000 until Feb 3's deposit.
    const strategy = new ScriptedStrategy({ "2025-01-31": [order("BUY", 15)] });
    const result = await sim(strategy, { AAA: flat("AAA") });
    assert.deepEqual(result.trades.map((t) => [t.date, t.quantity]), [["2025-02-03", 15]]);
    assert.deepEqual(result.rejections, []);
  });

  it("measures the benchmark with the same deposits, and gains with XIRR", async () => {
    // Price doubles on the last day: the initial ₹1,000 and Feb's ₹1,000 bought at
    // 100 are worth ₹4,000; March's ₹1,000 buys at the new open of 200.
    const prices = [100, 100, 100, 100, 200];
    const result = await sim(new ScriptedStrategy({}), { AAA: flat("AAA", prices) }, 1000);
    const m = result.metrics;
    assert.equal(m.benchmarkProfit, 2000); // 4000 + 1000 - 3000
    assert.ok(m.benchmarkMoneyWeightedReturnPct! > 1000, "a 67% gain in about a month annualises to a huge XIRR");
    assert.equal(m.profit, 0, "the strategy never bought");
  });

  it("allows starting from ₹0 with deposits only", async () => {
    const result = await sim(new ScriptedStrategy({}), { AAA: flat("AAA") }, 0);
    assert.equal(result.metrics.totalContributed, 2000);
    assert.equal(result.metrics.cagrPct, 0, "days with zero equity are skipped, not divided by");
  });
});

describe("index comparison", () => {
  // AAA (traded) rallies; IDX (index) is flat at 100, then doubles on the last day.
  const days = ["2025-01-30", "2025-01-31", "2025-02-03", "2025-02-04", "2025-03-03"];
  const bars = (symbol: string, prices: number[]) =>
    days.map((d, i) => ({
      symbol,
      open: prices[i],
      high: prices[i],
      low: prices[i],
      close: prices[i],
      volume: 1,
      timestamp: new Date(`${d}T00:00:00.000Z`),
    }));
  const AAA = bars("AAA", [100, 110, 120, 130, 140]);
  const run = (strategy: BaseStrategy, idx: number[], monthlyContribution = 0) =>
    simulate({
      strategy,
      params: {},
      candles: { AAA },
      index: { symbol: "IDX", candles: bars("IDX", idx) },
      from: new Date("2025-01-30"),
      to: new Date("2025-03-03"),
      initialCapital: 1000,
      monthlyContribution,
      costBps: 0,
      slippageBps: 0,
    });

  it("invests the same money in the index on the same days", async () => {
    const lump = (await run(new ScriptedStrategy({}), [100, 100, 100, 100, 100])).metrics;
    assert.deepEqual([lump.indexSymbol, lump.indexProfit, lump.indexReturnPct], ["IDX", 0, 0]);

    // ₹1,000 at 100, + ₹1,000 on Feb 3 at 100, + ₹1,000 on Mar 3 at the new open 200.
    // End: 10 + 10 + 5 units at 200 = 5,000 on 3,000 put in.
    const sip = (await run(new ScriptedStrategy({}), [100, 100, 100, 100, 200], 1000)).metrics;
    assert.deepEqual([sip.indexProfit, sip.indexReturnPct], [2000, 66.67]);
    assert.ok(sip.indexMoneyWeightedReturnPct! > 0);
    // The same-symbols benchmark is separate: AAA bought at 100, 120 and 140, worth 140 at the end.
    assert.equal(sip.benchmarkProfit, 566.67);
  });

  it("never shows the index to the strategy", async () => {
    const strategy = new ScriptedStrategy({});
    await run(strategy, [100, 100, 100, 100, 100]);
    assert.ok(strategy.seen.length > 0);
    for (const ctx of strategy.seen) {
      assert.deepEqual(Object.keys(ctx.bars!), ["AAA"]);
      assert.deepEqual(ctx.market.ticks.map((t) => t.symbol), ["AAA"]);
    }
  });

  it("leaves the index metrics out when the index has no bars in range", async () => {
    const m = (await simulate({
      strategy: new ScriptedStrategy({}),
      params: {},
      candles: { AAA },
      index: { symbol: "IDX", candles: [] },
      from: new Date("2025-01-30"),
      to: new Date("2025-03-03"),
      initialCapital: 1000,
      costBps: 0,
    })).metrics;
    assert.equal(m.indexSymbol, undefined);
    assert.equal(m.indexProfit, undefined);
  });
});

describe("FD comparison", () => {
  const curveTo = (date: string) => [{ date, equity: 0 }];

  it("compounds a lump sum at the annual effective rate", () => {
    const m = fdMetrics(7, [{ date: "2025-01-01", amount: 10_000 }], curveTo("2026-01-01"));
    assert.deepEqual(m, { fdRatePct: 7, fdProfit: 700, fdReturnPct: 7 });
  });

  it("compounds each deposit only from its own date, so its XIRR is the rate", () => {
    const flows = [
      { date: "2025-01-01", amount: 1000 },
      { date: "2025-07-02", amount: 1000 }, // 183 days before the end
      { date: "2026-01-01", amount: 1000 }, // deposited on the last day: no interest
    ];
    const m = fdMetrics(10, flows, curveTo("2026-01-01"));
    const end = 1000 * 1.1 + 1000 * 1.1 ** (183 / 365) + 1000;
    assert.equal(m.fdProfit, Number((end - 3000).toFixed(2)));
    const rate = xirr([...flows.map((f) => ({ date: f.date, amount: -f.amount })), { date: "2026-01-01", amount: end }]);
    assert.ok(Math.abs(rate! - 0.1) < 1e-6, `xirr ${rate}`);
  });

  it("never changes the strategy's own numbers", async () => {
    const strategy = () => new ScriptedStrategy({ [key(0)]: [order("BUY", 10)], [key(2)]: [order("SELL", 10)] });
    const input = { params: {}, candles: { AAA }, from: date(0), to: date(4), initialCapital: 10_000, costBps: 10 };
    const without = await simulate({ strategy: strategy(), ...input });
    const withFd = await simulate({ strategy: strategy(), ...input, fdRatePct: 7 });
    const { fdRatePct, fdProfit, fdReturnPct, ...rest } = withFd.metrics;
    assert.deepEqual(rest, without.metrics);
    assert.equal(fdRatePct, 7);
    assert.ok(fdProfit! > 0 && fdReturnPct! > 0);
    assert.deepEqual(withFd.equityCurve, without.equityCurve);
    assert.equal(without.metrics.fdRatePct, undefined, "off unless asked");
  });
});

describe("xirr", () => {
  it("solves simple cases and returns null without a sign change", () => {
    const r = xirr([{ date: "2024-01-01", amount: -100 }, { date: "2024-12-31", amount: 110 }]);
    assert.ok(Math.abs(r! - 0.1) < 1e-6);
    assert.equal(xirr([{ date: "2024-01-01", amount: -100 }, { date: "2024-12-31", amount: -5 }]), null);
    assert.equal(xirr([{ date: "2024-01-01", amount: -100 }]), null);
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
    const m = computeMetrics(100, curve, trades, 105);
    assert.equal(m.totalReturnPct, 10);
    assert.ok(Math.abs(m.cagrPct - 9.99) < 0.05, `cagr ${m.cagrPct}`);
    assert.equal(m.roundTrips, 2);
    assert.equal(m.winRatePct, 50);
    assert.equal(m.profitFactor, 3);
    assert.equal(m.benchmarkReturnPct, 5);
    assert.equal(m.profit, 10);
    assert.equal(m.totalContributed, 100);
    // Lump sum: XIRR ~ CAGR (366 days in 2024 vs a 365-day XIRR year).
    assert.ok(Math.abs(m.moneyWeightedReturnPct! - 9.97) < 0.05, `xirr ${m.moneyWeightedReturnPct}`);
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
    ["rsi-reversion", new RsiMeanReversionStrategy()],
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

  it("sizes buys as a % of equity end to end", async () => {
    const { service } = makeService({ TREND });
    const run = await service.run("u1", { ...base, params: { fastPeriod: 3, slowPeriod: 5, sizing: "percent", positionPct: 50 } });
    // 50% of ₹1,00,000 at the day-1 close of 104 -> floor(50000 / 104) = 480 shares.
    assert.equal(run.trades[0].quantity, 480);
    assert.ok(run.metrics.exposurePct > 20, "far more invested than 10 fixed shares");
  });

  it("warns when no signals fire, and when buys are below one share", async () => {
    const FLAT = candles("FLAT", Array.from({ length: 21 }, () => [100, 100] as [number, number]), -9);
    const { service } = makeService({ TREND, FLAT });

    const none = await service.run("u1", { ...base, symbols: ["FLAT"] });
    assert.equal(none.metrics.signalCount, 0);
    assert.match(none.warnings.join(), /No signals fired between .* and /);

    // 1% of ₹1,000 = ₹10, below the ₹104 share price.
    const tiny = await service.run("u1", {
      ...base,
      initialCapital: 1000,
      params: { fastPeriod: 3, slowPeriod: 5, sizing: "percent", positionPct: 1 },
    });
    assert.deepEqual([tiny.metrics.signalCount, tiny.metrics.skippedSignals, tiny.trades.length], [1, 1, 0]);
    assert.match(tiny.warnings.join(), /1 of 1 signals placed no order/);

    const fine = await service.run("u1", base);
    assert.equal(fine.metrics.signalCount, 2);
    assert.deepEqual(fine.warnings, []);
  });

  it("removes bad bars before the strategy sees them, with a warning", async () => {
    // Quiet market (RSI near 50) with a two-day ÷10 glitch on days 5 and 6.
    const closes = Array.from({ length: 21 }, (_, i) => (i === 14 || i === 15 ? 10 : i % 2 ? 101 : 100));
    const GLITCH = candles("GLITCH", closes.map((c) => [c, c] as [number, number]), -9);
    const request = {
      ...base,
      strategyId: "rsi-reversion",
      symbols: ["GLITCH"],
      params: { period: 2, oversold: 30, exitLevel: 55, orderSize: 1 },
    };

    // Without cleaning, the fake crash is a textbook RSI buy.
    const raw = await simulate({
      strategy: new RsiMeanReversionStrategy(),
      params: { ...new RsiMeanReversionStrategy().getDefaultParams(), ...request.params },
      candles: { GLITCH },
      from: base.from,
      to: base.to,
      initialCapital: 100_000,
      costBps: 0,
    });
    assert.ok(raw.trades.some((t) => t.side === "BUY"), "the glitch would trigger a buy");

    const { service } = makeService({ GLITCH });
    const run = await service.run("u1", request);
    assert.deepEqual(run.trades, []);
    assert.match(run.warnings.join(" | "), new RegExp(`GLITCH: removed 2 bad bars \\(${key(5)}, ${key(6)}\\)`));
    assert.ok(!run.equityCurve.some((p) => p.date === key(5) || p.date === key(6)), "glitch days are not trading days");
  });

  it("adds an index comparison when asked, and never fails the run over it", async () => {
    const IDX = candles("IDX", Array.from({ length: 21 }, () => [100, 100] as [number, number]), -9);
    const { service } = makeService({ TREND, IDX });

    const withIndex = await service.run("u1", { ...base, benchmarkSymbol: "idx" });
    assert.deepEqual([withIndex.metrics.indexSymbol, withIndex.metrics.indexProfit], ["IDX", 0]);
    assert.deepEqual(withIndex.warnings, []);

    const off = await service.run("u1", base);
    assert.equal(off.metrics.indexSymbol, undefined, "no benchmarkSymbol, no comparison");

    const broken = await service.run("u1", { ...base, benchmarkSymbol: "BROKEN" });
    assert.equal(broken.metrics.indexSymbol, undefined);
    assert.match(broken.warnings.join(), /Index benchmark BROKEN unavailable \(socket hang up\)/);

    const empty = await service.run("u1", { ...base, benchmarkSymbol: "MISSING" });
    assert.match(empty.warnings.join(), /Index benchmark MISSING: no data in the backtest dates/);

    const traded = await service.run("u1", { ...base, benchmarkSymbol: "TREND" });
    assert.equal(traded.metrics.indexSymbol, "TREND", "reuses the traded symbol's candles");
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
    assert.match(await status(service.run("u1", { ...base, initialCapital: 0 })), /^400 'initialCapital'/);
    assert.equal(await status(service.run("u1", { ...base, initialCapital: 0, monthlyContribution: 5000 })), "ok");
    assert.match(await status(service.run("u1", { ...base, monthlyContribution: -1 })), /^400 'monthlyContribution'/);
    assert.match(await status(service.run("u1", { ...base, fdRatePct: 25 })), /^400 'fdRatePct'/);
    assert.equal((await service.run("u1", { ...base, fdRatePct: 7 })).metrics.fdRatePct, 7);
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
