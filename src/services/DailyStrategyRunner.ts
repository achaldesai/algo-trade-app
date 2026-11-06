import type MarketDataService from "./MarketDataService";
import type TradingEngine from "./TradingEngine";
import type { HistoricalDataService } from "./HistoricalDataService";
import type { UserRepo } from "../db/repositories/UserRepo";
import type { StrategyConfigRepo } from "../db/repositories/StrategyConfigRepo";
import type { HistoricalCandle } from "../types";
import { warmupFetchStart } from "../strategies/dailyIndicators";
import { IST_OFFSET_MS } from "../utils/marketHours";
import logger from "../utils/logger";

/** 15:15 IST — 15 minutes before NSE close, so market orders still fill today. */
export const DAILY_RUN_IST_MINUTES = 15 * 60 + 15;

export interface DailyRunSummary {
  ranAt: string;
  skipped?: string;
  evaluations: number;
  orders: number;
  errors: number;
}

export interface DailyStrategyRunnerDeps {
  tradingEngine: TradingEngine;
  marketData: MarketDataService;
  historicalData: HistoricalDataService;
  userRepo: UserRepo;
  strategyConfigRepo: StrategyConfigRepo;
  /** Daily strategies trade only while the trading loop is switched on. */
  isTradingEnabled: () => boolean;
  now?: () => Date;
}

const istDayKey = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Milliseconds until the next weekday 15:15 IST strictly after `now`. */
export function msUntilNextRun(now: Date): number {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const target = new Date(ist);
  target.setUTCHours(Math.floor(DAILY_RUN_IST_MINUTES / 60), DAILY_RUN_IST_MINUTES % 60, 0, 0);
  if (target <= ist) target.setUTCDate(target.getUTCDate() + 1);
  while (target.getUTCDay() === 0 || target.getUTCDay() === 6) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - ist.getTime();
}

/**
 * Runs `1day` strategies once per trading day, near the close.
 *
 * - Only users who explicitly enabled a daily strategy are evaluated (opt-in;
 *   unlike tick strategies there is no run-everything-with-defaults fallback).
 * - Only while trading is switched on, so START/STOP, panic-sell and the feed
 *   health kill switch also govern daily strategies.
 * - Bars are daily history plus today's bar from the live price. A symbol with
 *   no tick today (e.g. a market holiday) is left out.
 * - Orders go through TradingEngine.evaluate, i.e. the usual risk checks,
 *   circuit breaker and stop-loss hooks.
 */
export class DailyStrategyRunner {
  private timer: NodeJS.Timeout | null = null;
  private lastRun: DailyRunSummary | null = null;
  private nextRunAt: Date | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: DailyStrategyRunnerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  start(): void {
    this.stop();
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  getStatus(): { scheduled: boolean; nextRunAt: string | null; lastRun: DailyRunSummary | null } {
    return { scheduled: this.timer !== null, nextRunAt: this.nextRunAt?.toISOString() ?? null, lastRun: this.lastRun };
  }

  private schedule(): void {
    const delay = msUntilNextRun(this.now());
    this.nextRunAt = new Date(this.now().getTime() + delay);
    logger.info({ nextRunAt: this.nextRunAt.toISOString() }, "Daily strategy run scheduled");
    this.timer = setTimeout(() => {
      this.runOnce()
        .catch((err) => logger.error({ err }, "Daily strategy run failed"))
        .finally(() => this.schedule());
    }, delay);
    this.timer.unref?.();
  }

  /** Evaluate every enabled daily strategy for every user. Exposed for tests. */
  async runOnce(): Promise<DailyRunSummary> {
    const ranAt = this.now();
    const summary: DailyRunSummary = { ranAt: ranAt.toISOString(), evaluations: 0, orders: 0, errors: 0 };
    this.lastRun = summary;

    if (!this.deps.isTradingEnabled()) {
      summary.skipped = "Trading is stopped";
      logger.info(summary, "Daily strategy run skipped");
      return summary;
    }

    const daily = new Map(
      this.deps.tradingEngine
        .getStrategies()
        .filter((s) => s.timeframe === "1day")
        .map((s) => [s.id, s]),
    );
    const jobs = this.deps.userRepo.listUsers().flatMap((user) =>
      this.deps.strategyConfigRepo
        .getActiveStrategies(user.id)
        .filter((c) => daily.has(c.strategyId))
        .map((c) => ({ userId: user.id, strategy: daily.get(c.strategyId)!, params: c.params })),
    );
    if (jobs.length === 0) {
      summary.skipped = "No users have a daily strategy enabled";
      return summary;
    }

    const today = istDayKey(ranAt);
    const symbols = this.deps.marketData
      .getTrackedSymbols()
      .filter((symbol) => {
        const tick = this.deps.marketData.getTick(symbol);
        return tick !== undefined && istDayKey(tick.timestamp) === today;
      });
    if (symbols.length === 0) {
      summary.skipped = "No live prices today (holiday or feed down)";
      logger.warn(summary, "Daily strategy run skipped");
      return summary;
    }

    const maxWarmup = Math.max(...jobs.map((j) => j.strategy.getWarmupBars({ ...j.strategy.getDefaultParams(), ...j.params })));
    const history = await this.loadBars(symbols, maxWarmup, ranAt, today);

    for (const job of jobs) {
      const window = job.strategy.getWarmupBars({ ...job.strategy.getDefaultParams(), ...job.params }) + 1;
      const bars = Object.fromEntries(Object.entries(history).map(([s, b]) => [s, b.slice(-window)]));
      try {
        const result = await this.deps.tradingEngine.evaluate(job.strategy.id, job.userId, job.params, { bars });
        summary.evaluations++;
        summary.orders += result.executions.reduce((n, e) => n + e.executions.length, 0);
        summary.errors += result.errors.length;
      } catch (err) {
        summary.errors++;
        logger.error({ err, strategyId: job.strategy.id, userId: job.userId }, "Daily strategy evaluation failed");
      }
    }

    logger.info(summary, "Daily strategy run completed");
    return summary;
  }

  private async loadBars(
    symbols: string[],
    warmupBars: number,
    now: Date,
    today: string,
  ): Promise<Record<string, HistoricalCandle[]>> {
    const bars: Record<string, HistoricalCandle[]> = {};
    for (const symbol of symbols) {
      const tick = this.deps.marketData.getTick(symbol)!;
      try {
        const past = (
          await this.deps.historicalData.getHistoricalData({
            symbol,
            interval: "1day",
            fromDate: warmupFetchStart(now, warmupBars),
            toDate: now,
          })
        ).filter((b) => istDayKey(b.timestamp) !== today);

        // Today's bar from the session's ticks; strategies use the close.
        const prices = this.deps.marketData
          .getTickHistory(symbol)
          .filter((t) => istDayKey(t.timestamp) === today)
          .map((t) => t.price);
        if (prices.length === 0) prices.push(tick.price);
        past.push({
          symbol,
          open: prices[0],
          high: Math.max(...prices),
          low: Math.min(...prices),
          close: tick.price,
          volume: tick.volume,
          timestamp: tick.timestamp,
        });
        bars[symbol] = past;
      } catch (err) {
        logger.warn({ err, symbol }, "No daily history for symbol; leaving it out of today's run");
      }
    }
    return bars;
  }
}

export default DailyStrategyRunner;
