import { randomBytes } from "node:crypto";
import type BaseStrategy from "../strategies/BaseStrategy";
import type BrokerClient from "../brokers/BrokerClient";
import { MARKET_SLIPPAGE_BPS } from "../brokers/PaperBroker";
import { resolveStrategyParams } from "../strategies/validateParams";
import { warmupFetchStart } from "../strategies/dailyIndicators";
import { DelistedSymbolError, type HistoricalDataService } from "./HistoricalDataService";
import type TradingEngine from "./TradingEngine";
import type { BacktestRepo } from "../db/repositories/BacktestRepo";
import type {
  BrokerOrderRequest,
  HistoricalCandle,
  PortfolioPositionSnapshot,
  TradeSide,
} from "../types";
import { HttpError } from "../utils/HttpError";
import logger from "../utils/logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export const MAX_SYMBOLS = 10;
export const MAX_RANGE_YEARS = 10;
export const DEFAULT_COST_BPS = 10;
const TRADING_DAYS_PER_YEAR = 252;

export interface BacktestRequest {
  strategyId: string;
  symbols: string[];
  from: Date;
  to: Date;
  params?: Record<string, unknown>;
  initialCapital: number;
  /** Brokerage + taxes per side, in basis points of notional. */
  costBps?: number;
}

export interface BacktestTrade {
  date: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  cost: number;
  /** Realized P&L (net of costs on both legs), set on sells. */
  pnl?: number;
}

export interface BacktestRejection {
  date: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  reason: string;
}

export interface EquityPoint {
  date: string;
  equity: number;
}

export interface BacktestMetrics {
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  /** Annualised, 0% risk-free; null when returns have no variance. */
  sharpe: number | null;
  trades: number;
  roundTrips: number;
  winRatePct: number | null;
  /** Gross wins / gross losses; null when there are no losing round trips. */
  profitFactor: number | null;
  /** Equal-weight buy-and-hold of the same symbols over the same dates. */
  benchmarkReturnPct: number;
  /**
   * Average share of equity held in positions at each close. Read returns
   * against this: the benchmark is always 100% invested.
   */
  exposurePct: number;
}

export interface BacktestRun {
  id: string;
  userId: string;
  createdAt: string;
  strategyId: string;
  strategyName: string;
  symbols: string[];
  from: string;
  to: string;
  params: Record<string, unknown>;
  initialCapital: number;
  costBps: number;
  metrics: BacktestMetrics;
  equityCurve: EquityPoint[];
  trades: BacktestTrade[];
  rejections: BacktestRejection[];
  warnings: string[];
}

export type BacktestSummary = Omit<BacktestRun, "equityCurve" | "trades" | "rejections">;

// ─── Simulation (pure) ───────────────────────────────────────────────────────

interface Position {
  quantity: number;
  /** Cost basis per share, including buy-side costs. */
  basis: number;
}

export interface SimulationInput {
  strategy: BaseStrategy;
  params: Record<string, unknown>;
  /** Daily candles per symbol, including warm-up history before `from`. */
  candles: Record<string, HistoricalCandle[]>;
  from: Date;
  to: Date;
  initialCapital: number;
  costBps: number;
  slippageBps?: number;
  userId?: string;
}

export interface SimulationResult {
  equityCurve: EquityPoint[];
  trades: BacktestTrade[];
  rejections: BacktestRejection[];
  metrics: BacktestMetrics;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const round = (n: number, dp = 2) => Number(n.toFixed(dp));

// Strategies don't place orders themselves; the simulator fills their signals.
const noopBroker = {
  name: "backtest",
  connect: async () => undefined,
  disconnect: async () => undefined,
  isConnected: () => true,
  getPositions: async () => [],
  placeOrder: async () => {
    throw new Error("Strategies must not place orders directly during a backtest");
  },
} as unknown as BrokerClient;

/**
 * Replay daily bars through a `1day` strategy.
 *
 * Signals generated from day t's close are filled at day t+1's open (no
 * look-ahead), with slippage against the trader and `costBps` per side.
 * Long-only: sells are capped at the held quantity. Buys that exceed cash are
 * rejected rather than resized.
 */
export async function simulate(input: SimulationInput): Promise<SimulationResult> {
  const { strategy, params, from, to, initialCapital, costBps } = input;
  const slippage = (input.slippageBps ?? MARKET_SLIPPAGE_BPS) / 10_000;
  const window = strategy.getWarmupBars(params) + 1;
  const fromKey = dayKey(from);
  const toKey = dayKey(to);

  const series = Object.fromEntries(
    Object.entries(input.candles).map(([symbol, bars]) => [
      symbol,
      [...bars].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
    ]),
  );
  const indexByDay = new Map<string, Map<string, number>>();
  for (const [symbol, bars] of Object.entries(series)) {
    bars.forEach((bar, i) => {
      const key = dayKey(bar.timestamp);
      if (key < fromKey || key > toKey) return;
      if (!indexByDay.has(key)) indexByDay.set(key, new Map());
      indexByDay.get(key)!.set(symbol, i);
    });
  }
  const days = [...indexByDay.keys()].sort();

  let cash = initialCapital;
  const positions = new Map<string, Position>();
  const lastClose = new Map<string, number>();
  const firstOpen = new Map<string, number>();
  const trades: BacktestTrade[] = [];
  const rejections: BacktestRejection[] = [];
  const equityCurve: EquityPoint[] = [];
  let exposureSum = 0;
  let pending: BrokerOrderRequest[] = [];

  for (let d = 0; d < days.length; d++) {
    const day = days[d];
    const today = indexByDay.get(day)!;

    // 1. Fill yesterday's signals at today's open.
    for (const order of pending) {
      const i = today.get(order.symbol);
      const reject = (reason: string) =>
        rejections.push({ date: day, symbol: order.symbol, side: order.side, quantity: order.quantity, reason });
      if (i === undefined) {
        reject("No bar on fill day");
        continue;
      }
      const open = series[order.symbol][i].open;
      const held = positions.get(order.symbol);

      if (order.side === "BUY") {
        const price = open * (1 + slippage);
        const notional = price * order.quantity;
        const cost = (notional * costBps) / 10_000;
        if (notional + cost > cash) {
          reject(`Insufficient cash: need ${round(notional + cost)}, have ${round(cash)}`);
          continue;
        }
        cash -= notional + cost;
        const qty = (held?.quantity ?? 0) + order.quantity;
        const basis = ((held?.quantity ?? 0) * (held?.basis ?? 0) + notional + cost) / qty;
        positions.set(order.symbol, { quantity: qty, basis });
        trades.push({ date: day, symbol: order.symbol, side: "BUY", quantity: order.quantity, price: round(price, 4), cost: round(cost) });
      } else {
        const quantity = Math.min(order.quantity, held?.quantity ?? 0);
        if (!held || quantity <= 0) {
          reject("No position to sell (long-only)");
          continue;
        }
        const price = open * (1 - slippage);
        const proceeds = price * quantity;
        const cost = (proceeds * costBps) / 10_000;
        cash += proceeds - cost;
        const pnl = proceeds - cost - held.basis * quantity;
        if (held.quantity === quantity) positions.delete(order.symbol);
        else positions.set(order.symbol, { quantity: held.quantity - quantity, basis: held.basis });
        trades.push({ date: day, symbol: order.symbol, side: "SELL", quantity, price: round(price, 4), cost: round(cost), pnl: round(pnl) });
      }
    }
    pending = [];

    // 2. Mark to market at today's close.
    for (const [symbol, i] of today) {
      const bar = series[symbol][i];
      lastClose.set(symbol, bar.close);
      if (!firstOpen.has(symbol)) firstOpen.set(symbol, bar.open);
    }
    let invested = 0;
    for (const [symbol, pos] of positions) invested += pos.quantity * (lastClose.get(symbol) ?? 0);
    const equity = cash + invested;
    if (equity > 0) exposureSum += invested / equity;
    equityCurve.push({ date: day, equity: round(equity) });

    // 3. Ask the strategy for tomorrow's orders (nothing to fill after the last day).
    if (d === days.length - 1) break;
    const bars: Record<string, HistoricalCandle[]> = {};
    const ticks = [];
    let asOf = new Date(0);
    for (const [symbol, i] of today) {
      const bar = series[symbol][i];
      bars[symbol] = series[symbol].slice(Math.max(0, i + 1 - window), i + 1);
      ticks.push({ symbol, price: bar.close, volume: bar.volume, timestamp: bar.timestamp });
      if (bar.timestamp > asOf) asOf = bar.timestamp;
    }
    const portfolioPositions: PortfolioPositionSnapshot[] = [...positions].map(([symbol, pos]) => ({
      symbol,
      name: symbol,
      netQuantity: pos.quantity,
      averageEntryPrice: pos.basis,
      realizedPnl: 0,
      position: "LONG",
      unrealizedPnl: (lastClose.get(symbol)! - pos.basis) * pos.quantity,
    }));

    let signals;
    try {
      signals = await strategy.generateSignals({
        market: { ticks, asOf },
        portfolio: { generatedAt: asOf, positions: portfolioPositions, totalTrades: trades.length },
        broker: noopBroker,
        params,
        userId: input.userId ?? "backtest",
        bars,
      });
    } catch (error) {
      throw new HttpError(400, `Strategy rejected the parameters: ${(error as Error).message}`);
    }
    pending = signals.flatMap((s) => s.requestedOrders);
  }

  const benchmark = [...firstOpen].map(([symbol, open]) => lastClose.get(symbol)! / open - 1);
  const benchmarkReturn = benchmark.length ? benchmark.reduce((a, b) => a + b, 0) / benchmark.length : 0;

  return {
    equityCurve,
    trades,
    rejections,
    metrics: computeMetrics(
      initialCapital,
      equityCurve,
      trades,
      benchmarkReturn,
      days.length ? exposureSum / days.length : 0,
    ),
  };
}

export function computeMetrics(
  initialCapital: number,
  equityCurve: EquityPoint[],
  trades: BacktestTrade[],
  benchmarkReturn: number,
  exposure = 0,
): BacktestMetrics {
  const endEquity = equityCurve.at(-1)?.equity ?? initialCapital;
  const totalReturn = endEquity / initialCapital - 1;

  let peak = initialCapital;
  let maxDrawdown = 0;
  for (const { equity } of equityCurve) {
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  const returns: number[] = [];
  let prev = initialCapital;
  for (const { equity } of equityCurve) {
    returns.push(equity / prev - 1);
    prev = equity;
  }
  let sharpe: number | null = null;
  if (returns.length > 1) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
    const sd = Math.sqrt(variance);
    if (sd > 0) sharpe = round((mean / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR));
  }

  let cagr = 0;
  if (equityCurve.length > 1) {
    const years = (Date.parse(equityCurve.at(-1)!.date) - Date.parse(equityCurve[0].date)) / (365.25 * 86_400_000);
    if (years > 0 && endEquity > 0) cagr = (endEquity / initialCapital) ** (1 / years) - 1;
  }

  const closed = trades.filter((t) => t.pnl !== undefined);
  const wins = closed.filter((t) => t.pnl! > 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl!, 0);
  const grossLoss = closed.filter((t) => t.pnl! < 0).reduce((a, t) => a - t.pnl!, 0);

  return {
    startEquity: initialCapital,
    endEquity: round(endEquity),
    totalReturnPct: round(totalReturn * 100),
    cagrPct: round(cagr * 100),
    maxDrawdownPct: round(maxDrawdown * 100),
    sharpe,
    trades: trades.length,
    roundTrips: closed.length,
    winRatePct: closed.length ? round((wins.length / closed.length) * 100) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    benchmarkReturnPct: round(benchmarkReturn * 100),
    exposurePct: round(exposure * 100),
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class BacktestService {
  constructor(
    private readonly tradingEngine: TradingEngine,
    private readonly historicalData: HistoricalDataService,
    private readonly repo: BacktestRepo,
  ) {}

  async run(userId: string, request: BacktestRequest): Promise<BacktestRun> {
    const strategy = this.tradingEngine.getStrategy(request.strategyId);
    if (!strategy) throw new HttpError(404, `Unknown strategy: ${request.strategyId}`);
    if (strategy.timeframe !== "1day") {
      throw new HttpError(400, `Strategy '${strategy.id}' runs on live ticks and can't be backtested on daily bars`);
    }

    const symbols = [...new Set(request.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    if (symbols.length === 0) throw new HttpError(400, "At least one symbol is required");
    if (symbols.length > MAX_SYMBOLS) throw new HttpError(400, `At most ${MAX_SYMBOLS} symbols per backtest`);
    if (!(request.from < request.to)) throw new HttpError(400, "'from' must be before 'to'");
    const maxTo = new Date(request.from);
    maxTo.setFullYear(maxTo.getFullYear() + MAX_RANGE_YEARS);
    if (request.to > maxTo) throw new HttpError(400, `Date range can be at most ${MAX_RANGE_YEARS} years`);

    const params = resolveStrategyParams(strategy, request.params);
    const costBps = request.costBps ?? DEFAULT_COST_BPS;

    const fetchFrom = warmupFetchStart(request.from, strategy.getWarmupBars(params));

    const warnings: string[] = [];
    const candles: Record<string, HistoricalCandle[]> = {};
    for (const symbol of symbols) {
      try {
        const bars = await this.historicalData.getHistoricalData({
          symbol,
          interval: "1day",
          fromDate: fetchFrom,
          toDate: request.to,
        });
        if (bars.length === 0) warnings.push(`${symbol}: no data in range, skipped`);
        else candles[symbol] = bars;
      } catch (error) {
        if (error instanceof DelistedSymbolError) {
          warnings.push(`${symbol}: no historical data (delisted or unsupported), skipped`);
          continue;
        }
        throw new HttpError(502, `Failed to fetch history for ${symbol}: ${(error as Error).message}`);
      }
    }
    if (Object.keys(candles).length === 0) {
      throw new HttpError(422, "No historical data for any requested symbol", { warnings });
    }

    const result = await simulate({
      strategy,
      params,
      candles,
      from: request.from,
      to: request.to,
      initialCapital: request.initialCapital,
      costBps,
      userId,
    });
    if (result.equityCurve.length === 0) {
      throw new HttpError(422, "No trading days in the requested range", { warnings });
    }

    const run: BacktestRun = {
      id: `${Date.now().toString(36).padStart(9, "0")}-${randomBytes(3).toString("hex")}`,
      userId,
      createdAt: new Date().toISOString(),
      strategyId: strategy.id,
      strategyName: strategy.name,
      symbols,
      from: dayKey(request.from),
      to: dayKey(request.to),
      params,
      initialCapital: request.initialCapital,
      costBps,
      ...result,
      warnings,
    };
    await this.repo.save(run);
    logger.info(
      { userId, runId: run.id, strategyId: run.strategyId, symbols, totalReturnPct: run.metrics.totalReturnPct },
      "Backtest completed",
    );
    return run;
  }

  list(userId: string): BacktestSummary[] {
    return this.repo.list(userId);
  }

  get(userId: string, id: string): BacktestRun {
    const run = this.repo.get(userId, id);
    if (!run) throw new HttpError(404, "Backtest not found");
    return run;
  }

  async delete(userId: string, id: string): Promise<void> {
    if (!(await this.repo.delete(userId, id))) throw new HttpError(404, "Backtest not found");
  }
}

export default BacktestService;
