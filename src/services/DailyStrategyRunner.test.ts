import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DailyStrategyRunner, msUntilNextRun } from "./DailyStrategyRunner";
import MovingAverageCrossoverStrategy from "../strategies/MovingAverageCrossoverStrategy";
import VWAPStrategy from "../strategies/VWAPStrategy";
import type TradingEngine from "./TradingEngine";
import type MarketDataService from "./MarketDataService";
import type { HistoricalDataService } from "./HistoricalDataService";
import type { UserRepo } from "../db/repositories/UserRepo";
import type { StrategyConfigRepo } from "../db/repositories/StrategyConfigRepo";
import type { HistoricalCandle, MarketTick } from "../types";

// 2026-11-06 is a Friday. 15:15 IST = 09:45 UTC.
const ist = (iso: string) => new Date(`${iso}+05:30`);

describe("msUntilNextRun", () => {
  it("targets 15:15 IST on the same weekday when before it", () => {
    assert.equal(msUntilNextRun(ist("2026-11-06T15:14:00")), 60_000);
  });

  it("rolls past the weekend after Friday's run", () => {
    const now = ist("2026-11-06T15:15:00");
    assert.equal(new Date(now.getTime() + msUntilNextRun(now)).toISOString(), "2026-11-09T09:45:00.000Z");
  });

  it("from a Saturday, runs Monday", () => {
    const now = ist("2026-11-07T10:00:00");
    assert.equal(new Date(now.getTime() + msUntilNextRun(now)).toISOString(), "2026-11-09T09:45:00.000Z");
  });
});

describe("DailyStrategyRunner.runOnce", () => {
  const NOW = ist("2026-11-06T15:15:00");
  const DAY = 86_400_000;

  function history(symbol: string, days: number): HistoricalCandle[] {
    // Ends with a bar dated "today", which the runner must replace with the live bar.
    return Array.from({ length: days }, (_, i) => ({
      symbol,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1,
      timestamp: new Date(NOW.getTime() - (days - 1 - i) * DAY),
    }));
  }

  function setup(opts: {
    tradingOn?: boolean;
    configs?: Record<string, { strategyId: string; enabled: boolean; params: Record<string, unknown> }[]>;
    ticks?: Record<string, MarketTick>;
  }) {
    const calls: { strategyId: string; userId: string; bars?: Record<string, HistoricalCandle[]> }[] = [];
    const strategies = [new VWAPStrategy(), new MovingAverageCrossoverStrategy()];
    const ticks = opts.ticks ?? {
      TCS: { symbol: "TCS", price: 123, volume: 9, timestamp: ist("2026-11-06T15:14:30") },
    };
    const configs = opts.configs ?? {
      u1: [{ strategyId: "ma-crossover", enabled: true, params: { fastPeriod: 3, slowPeriod: 5 } }],
    };
    const runner = new DailyStrategyRunner({
      now: () => NOW,
      isTradingEnabled: () => opts.tradingOn ?? true,
      tradingEngine: {
        getStrategies: () => strategies,
        evaluate: async (strategyId: string, userId: string, _p: unknown, o: { bars?: Record<string, HistoricalCandle[]> }) => {
          calls.push({ strategyId, userId, bars: o.bars });
          return { executions: [{ executions: [{}] }], errors: [] };
        },
      } as unknown as TradingEngine,
      marketData: {
        getTrackedSymbols: () => Object.keys(ticks),
        getTick: (s: string) => ticks[s],
        getTickHistory: (s: string) =>
          ticks[s] ? [{ ...ticks[s], price: 110, timestamp: ist("2026-11-06T09:20:00") }, ticks[s]] : [],
      } as unknown as MarketDataService,
      historicalData: {
        getHistoricalData: async ({ symbol }: { symbol: string }) => history(symbol, 30),
      } as unknown as HistoricalDataService,
      userRepo: { listUsers: () => Object.keys(configs).map((id) => ({ id })) } as unknown as UserRepo,
      strategyConfigRepo: {
        getActiveStrategies: (id: string) => (configs[id] ?? []).filter((c) => c.enabled),
      } as unknown as StrategyConfigRepo,
    });
    return { runner, calls };
  }

  it("does nothing while trading is stopped", async () => {
    const { runner, calls } = setup({ tradingOn: false });
    const summary = await runner.runOnce();
    assert.equal(summary.skipped, "Trading is stopped");
    assert.equal(calls.length, 0);
    assert.equal(runner.getStatus().lastRun, summary);
  });

  it("is opt-in: users without an enabled daily strategy are not evaluated", async () => {
    const { runner, calls } = setup({
      configs: {
        u1: [{ strategyId: "vwap", enabled: true, params: {} }],
        u2: [{ strategyId: "ma-crossover", enabled: false, params: {} }],
        u3: [],
      },
    });
    assert.match((await runner.runOnce()).skipped!, /No users/);
    assert.equal(calls.length, 0);
  });

  it("evaluates enabled daily strategies with history plus today's live bar", async () => {
    const { runner, calls } = setup({});
    const summary = await runner.runOnce();

    assert.deepEqual(summary, { ranAt: NOW.toISOString(), evaluations: 1, orders: 1, errors: 0 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].strategyId, "ma-crossover");
    const bars = calls[0].bars!.TCS;
    assert.equal(bars.length, 7, "window = warm-up (slow + 1 = 6) + today, same as backtests");
    const today = bars.at(-1)!;
    assert.deepEqual(
      { open: today.open, high: today.high, low: today.low, close: today.close },
      { open: 110, high: 123, low: 110, close: 123 },
      "built from today's ticks, replacing the provider's partial bar",
    );
    assert.equal(bars.filter((b) => b.timestamp.toISOString().startsWith("2026-11-06")).length, 1);
  });

  it("skips the run when no symbol has a tick today (holiday / feed down)", async () => {
    const { runner, calls } = setup({
      ticks: { TCS: { symbol: "TCS", price: 1, volume: 1, timestamp: ist("2026-11-05T15:29:00") } },
    });
    assert.match((await runner.runOnce()).skipped!, /No live prices today/);
    assert.equal(calls.length, 0);
  });
});
