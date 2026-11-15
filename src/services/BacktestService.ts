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
import { badBarsNote, cleanCandles } from "../utils/candles";
import logger from "../utils/logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export const MAX_SYMBOLS = 10;
export const MAX_RANGE_YEARS = 10;
export const DEFAULT_COST_BPS = 10;
/** Nifty 50 ETF: the API's default index comparison. */
export const DEFAULT_INDEX_SYMBOL = "NIFTYBEES";
const TRADING_DAYS_PER_YEAR = 252;

export interface BacktestRequest {
  strategyId: string;
  symbols: string[];
  from: Date;
  to: Date;
  params?: Record<string, unknown>;
  initialCapital: number;
  /** Added to cash on the first trading day of each month after the start. */
  monthlyContribution?: number;
  /** Brokerage + taxes per side, in basis points of notional. */
  costBps?: number;
  /**
   * Index to compare against, bought with the same deposits (e.g. NIFTYBEES).
   * Never shown to the strategy. Empty / absent = no index comparison.
   */
  benchmarkSymbol?: string | null;
  /**
   * Compare with a fixed deposit at this annual effective rate (%), funded
   * with the same cash flows. Absent / null = no FD comparison.
   */
  fdRatePct?: number | null;
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
  /** Money put in so far (initial capital + deposits). Absent on older runs. */
  contributed?: number;
}

export interface Contribution {
  date: string;
  amount: number;
}

export interface BacktestMetrics {
  startEquity: number;
  endEquity: number;
  /** Initial capital plus all deposits. */
  totalContributed: number;
  /** endEquity − totalContributed: deposits are not profit. */
  profit: number;
  /** profit / totalContributed. */
  totalReturnPct: number;
  /** Time-weighted (deposits stripped out of daily returns), annualised. */
  cagrPct: number;
  /**
   * XIRR: annualised return on the actual cash flows, i.e. what a monthly
   * investor earns. Null if it can't be solved.
   */
  moneyWeightedReturnPct: number | null;
  maxDrawdownPct: number;
  /** Annualised, 0% risk-free; null when returns have no variance. */
  sharpe: number | null;
  trades: number;
  roundTrips: number;
  winRatePct: number | null;
  /** Gross wins / gross losses; null when there are no losing round trips. */
  profitFactor: number | null;
  /**
   * Equal-weight buy-and-hold of the same symbols over the same dates, buying
   * with the same money on the same days (initial capital, then each deposit).
   */
  benchmarkReturnPct: number;
  benchmarkProfit: number;
  benchmarkMoneyWeightedReturnPct: number | null;
  /**
   * Average share of equity held in positions at each close. Read returns
   * against this: the benchmark is always 100% invested.
   */
  exposurePct: number;
  /**
   * The same cash flows invested in an index (e.g. a Nifty 50 ETF) on the same
   * days, no costs. Absent when no index was requested or it had no data.
   */
  indexSymbol?: string;
  indexProfit?: number;
  indexReturnPct?: number;
  indexMoneyWeightedReturnPct?: number | null;
  /**
   * The same cash flows in a fixed deposit at `fdRatePct` (annual effective,
   * pre-tax). Absent when no FD rate was given.
   */
  fdRatePct?: number;
  fdProfit?: number;
  fdReturnPct?: number;
  /** Strategy signals, including skipped buys. Absent on older runs. */
  signalCount?: number;
  /** Buy signals that placed no order (e.g. budget below one share). */
  skippedSignals?: number;
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
  /** Absent on runs saved before deposits existed (treat as 0). */
  monthlyContribution?: number;
  costBps: number;
  metrics: BacktestMetrics;
  equityCurve: EquityPoint[];
  trades: BacktestTrade[];
  rejections: BacktestRejection[];
  contributions?: Contribution[];
  warnings: string[];
}

export type BacktestSummary = Omit<BacktestRun, "equityCurve" | "trades" | "rejections" | "contributions">;

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
  monthlyContribution?: number;
  costBps: number;
  slippageBps?: number;
  userId?: string;
  /** Index series for the index comparison; not shown to the strategy. */
  index?: { symbol: string; candles: HistoricalCandle[] };
  /** Annual effective FD rate (%) for the FD comparison. */
  fdRatePct?: number | null;
}

export interface SimulationResult {
  equityCurve: EquityPoint[];
  trades: BacktestTrade[];
  rejections: BacktestRejection[];
  contributions: Contribution[];
  metrics: BacktestMetrics;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const round = (n: number, dp = 2) => Number(n.toFixed(dp)) + 0; // + 0 turns -0 into 0

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
 * rejected rather than resized. `monthlyContribution` is credited at the start
 * of the first trading day of each new month, before that day's fills.
 */
export async function simulate(input: SimulationInput): Promise<SimulationResult> {
  const { strategy, params, from, to, initialCapital, costBps } = input;
  const deposit = input.monthlyContribution ?? 0;
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
  let contributed = initialCapital;
  const positions = new Map<string, Position>();
  const lastClose = new Map<string, number>();
  const trades: BacktestTrade[] = [];
  const rejections: BacktestRejection[] = [];
  const contributions: Contribution[] = [];
  let signalCount = 0;
  let skippedSignals = 0;
  const equityCurve: EquityPoint[] = [];
  let exposureSum = 0;
  let pending: BrokerOrderRequest[] = [];

  for (let d = 0; d < days.length; d++) {
    const day = days[d];
    const today = indexByDay.get(day)!;

    // 0. Monthly deposit, credited before the fills so a buy can use it.
    if (deposit > 0 && d > 0 && day.slice(0, 7) !== days[d - 1].slice(0, 7)) {
      cash += deposit;
      contributed += deposit;
      contributions.push({ date: day, amount: deposit });
    }

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
    for (const [symbol, i] of today) lastClose.set(symbol, series[symbol][i].close);
    let invested = 0;
    for (const [symbol, pos] of positions) invested += pos.quantity * (lastClose.get(symbol) ?? 0);
    const equity = cash + invested;
    if (equity > 0) exposureSum += invested / equity;
    equityCurve.push({ date: day, equity: round(equity), contributed: round(contributed) });

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
        account: { cash, equity },
      });
    } catch (error) {
      throw new HttpError(400, `Strategy rejected the parameters: ${(error as Error).message}`);
    }
    signalCount += signals.length;
    skippedSignals += signals.filter((s) => s.skippedReason).length;
    pending = signals.flatMap((s) => s.requestedOrders);
  }

  const flows = days.length ? [{ date: days[0], amount: initialCapital }, ...contributions] : [];
  const benchmarkEnd = benchmarkValue(series, flows, fromKey, toKey, lastClose);

  return {
    equityCurve,
    trades,
    rejections,
    contributions,
    metrics: {
      ...computeMetrics(initialCapital, equityCurve, trades, benchmarkEnd, days.length ? exposureSum / days.length : 0),
      ...(input.index ? indexMetrics(input.index, flows, fromKey, toKey, equityCurve) : {}),
      ...(input.fdRatePct != null ? fdMetrics(input.fdRatePct, flows, equityCurve) : {}),
      signalCount,
      skippedSignals,
    },
  };
}

/**
 * The same money in a fixed deposit: each flow compounds at the annual
 * effective rate from its own date to the last backtest day. Pre-tax.
 */
export function fdMetrics(ratePct: number, flows: Contribution[], equityCurve: EquityPoint[]): Partial<BacktestMetrics> {
  const lastDate = equityCurve.at(-1)?.date;
  if (!lastDate) return {};
  const end = flows.reduce(
    (sum, f) => sum + f.amount * (1 + ratePct / 100) ** ((Date.parse(lastDate) - Date.parse(f.date)) / (365 * 86_400_000)),
    0,
  );
  const contributed = flows.reduce((sum, f) => sum + f.amount, 0);
  return {
    fdRatePct: ratePct,
    fdProfit: round(end - contributed),
    fdReturnPct: contributed > 0 ? round((end / contributed - 1) * 100) : 0,
  };
}

/** The same money invested in the index on the same days; {} if it has no bars in range. */
function indexMetrics(
  index: { symbol: string; candles: HistoricalCandle[] },
  flows: Contribution[],
  fromKey: string,
  toKey: string,
  equityCurve: EquityPoint[],
): Partial<BacktestMetrics> {
  const inRange = index.candles.filter((b) => dayKey(b.timestamp) >= fromKey && dayKey(b.timestamp) <= toKey);
  const last = inRange.reduce<HistoricalCandle | undefined>((a, b) => (!a || b.timestamp > a.timestamp ? b : a), undefined);
  const lastDate = equityCurve.at(-1)?.date;
  if (!last || !lastDate) return {};

  const end = benchmarkValue({ [index.symbol]: inRange }, flows, fromKey, toKey, new Map([[index.symbol, last.close]]));
  const contributed = flows.reduce((sum, f) => sum + f.amount, 0);
  const rate = xirr([...flows.map((f) => ({ date: f.date, amount: -f.amount })), { date: lastDate, amount: end }]);
  return {
    indexSymbol: index.symbol,
    indexProfit: round(end - contributed),
    indexReturnPct: contributed > 0 ? round((end / contributed - 1) * 100) : 0,
    indexMoneyWeightedReturnPct: rate === null ? null : round(rate * 100),
  };
}

/**
 * End value of buying the symbols in equal parts with each cash flow, at each
 * symbol's first open on or after the flow date, then holding to the last
 * close. No costs. With one flow this is the plain equal-weight buy-and-hold.
 */
function benchmarkValue(
  series: Record<string, HistoricalCandle[]>,
  flows: Contribution[],
  fromKey: string,
  toKey: string,
  lastClose: Map<string, number>,
): number {
  const inRange = Object.fromEntries(
    Object.entries(series).map(([symbol, bars]) => [
      symbol,
      bars.filter((b) => dayKey(b.timestamp) >= fromKey && dayKey(b.timestamp) <= toKey),
    ]),
  );
  let value = 0;
  for (const flow of flows) {
    const opens = Object.entries(inRange)
      .map(([symbol, bars]) => [symbol, bars.find((b) => dayKey(b.timestamp) >= flow.date)?.open] as const)
      .filter((e): e is readonly [string, number] => e[1] !== undefined && e[1] > 0);
    for (const [symbol, open] of opens) value += (flow.amount / opens.length / open) * lastClose.get(symbol)!;
  }
  return value;
}

/**
 * Annualised internal rate of return of dated cash flows (negative = money in,
 * positive = money out), by bisection. Null without a sign change in the range.
 */
export function xirr(flows: { date: string; amount: number }[]): number | null {
  if (flows.length < 2) return null;
  const t0 = Date.parse(flows[0].date);
  const years = flows.map((f) => (Date.parse(f.date) - t0) / (365 * 86_400_000));
  if (years.at(-1)! <= 0) return null;
  const npv = (rate: number) => flows.reduce((sum, f, i) => sum + f.amount / (1 + rate) ** years[i], 0);

  let lo = -0.9999;
  let hi = 10_000; // 1,000,000% a year: short, extreme runs can annualise very high
  let fLo = npv(lo);
  if (!Number.isFinite(fLo) || fLo * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-9) return mid;
    if (fLo * fMid < 0) hi = mid;
    else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Metrics from the equity curve. Deposits (read from each point's
 * `contributed`) are never counted as gains: daily returns strip out the day's
 * deposit (time-weighted), and profit is end equity minus money put in.
 */
export function computeMetrics(
  initialCapital: number,
  equityCurve: EquityPoint[],
  trades: BacktestTrade[],
  benchmarkEndValue: number,
  exposure = 0,
): BacktestMetrics {
  const endEquity = equityCurve.at(-1)?.equity ?? initialCapital;
  const totalContributed = equityCurve.at(-1)?.contributed ?? initialCapital;
  const profit = endEquity - totalContributed;

  // Time-weighted daily returns and a growth index built from them.
  const returns: number[] = [];
  let prevEquity = initialCapital;
  let prevContributed = initialCapital;
  let index = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const { equity, contributed = prevContributed } of equityCurve) {
    const deposited = contributed - prevContributed;
    if (prevEquity > 0) {
      const r = (equity - deposited) / prevEquity - 1;
      returns.push(r);
      index *= 1 + r;
      peak = Math.max(peak, index);
      maxDrawdown = Math.max(maxDrawdown, (peak - index) / peak);
    }
    prevEquity = equity;
    prevContributed = contributed;
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
    if (years > 0 && index > 0) cagr = index ** (1 / years) - 1;
  }

  // Cash flows for XIRR: money in (negative) on the first day and each deposit day.
  const flows: { date: string; amount: number }[] = [];
  let before = 0;
  for (const point of equityCurve) {
    const contributed = point.contributed ?? initialCapital;
    if (contributed !== before) flows.push({ date: point.date, amount: -(contributed - before) });
    before = contributed;
  }
  const lastDate = equityCurve.at(-1)?.date;
  const mwr = (end: number) => {
    if (!lastDate) return null;
    const rate = xirr([...flows, { date: lastDate, amount: end }]);
    return rate === null ? null : round(rate * 100);
  };

  const closed = trades.filter((t) => t.pnl !== undefined);
  const wins = closed.filter((t) => t.pnl! > 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl!, 0);
  const grossLoss = closed.filter((t) => t.pnl! < 0).reduce((a, t) => a - t.pnl!, 0);

  return {
    startEquity: initialCapital,
    endEquity: round(endEquity),
    totalContributed: round(totalContributed),
    profit: round(profit),
    totalReturnPct: totalContributed > 0 ? round((profit / totalContributed) * 100) : 0,
    cagrPct: round(cagr * 100),
    moneyWeightedReturnPct: mwr(endEquity),
    maxDrawdownPct: round(maxDrawdown * 100),
    sharpe,
    trades: trades.length,
    roundTrips: closed.length,
    winRatePct: closed.length ? round((wins.length / closed.length) * 100) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    benchmarkReturnPct: totalContributed > 0 ? round((benchmarkEndValue / totalContributed - 1) * 100) : 0,
    benchmarkProfit: round(benchmarkEndValue - totalContributed),
    benchmarkMoneyWeightedReturnPct: mwr(benchmarkEndValue),
    exposurePct: round(exposure * 100),
  };
}

/** Explain runs that traded little or nothing, so they don't look broken. */
export function signalWarnings(result: SimulationResult, from: string, to: string): string[] {
  const { signalCount = 0, skippedSignals = 0 } = result.metrics;
  if (signalCount === 0) {
    return [`No signals fired between ${from} and ${to}. The thresholds may be too strict for these symbols and dates.`];
  }
  if (skippedSignals > 0) {
    return [
      `${skippedSignals} of ${signalCount} signals placed no order: the position budget was below one share. ` +
        "Raise the position size or the capital, or pick cheaper symbols.",
    ];
  }
  return [];
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

    if (request.fdRatePct != null && !(request.fdRatePct >= 0 && request.fdRatePct <= 20)) {
      throw new HttpError(400, "'fdRatePct' must be between 0 and 20");
    }
    const monthlyContribution = request.monthlyContribution ?? 0;
    if (!(monthlyContribution >= 0)) throw new HttpError(400, "'monthlyContribution' must be 0 or more");
    if (!(request.initialCapital >= 0) || (request.initialCapital === 0 && monthlyContribution === 0)) {
      throw new HttpError(400, "'initialCapital' must be more than 0 unless there is a monthly contribution");
    }

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
        const { candles: clean, removed } = cleanCandles(bars);
        const note = badBarsNote(symbol, removed);
        if (note) warnings.push(note);
        if (clean.length === 0) warnings.push(`${symbol}: no data in range, skipped`);
        else candles[symbol] = clean;
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

    const index = await this.loadIndex(request, candles, warnings);

    const result = await simulate({
      strategy,
      params,
      candles,
      from: request.from,
      to: request.to,
      initialCapital: request.initialCapital,
      monthlyContribution,
      costBps,
      userId,
      index,
      fdRatePct: request.fdRatePct,
    });
    if (index && result.metrics.indexSymbol === undefined) {
      warnings.push(`Index benchmark ${index.symbol}: no data in the backtest dates, skipped`);
    }
    if (result.equityCurve.length === 0) {
      throw new HttpError(422, "No trading days in the requested range", { warnings });
    }
    warnings.push(...signalWarnings(result, dayKey(request.from), dayKey(request.to)));

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
      monthlyContribution,
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

  /**
   * Candles for the index comparison, or undefined. Unlike strategy symbols, a
   * missing index never fails the run: it becomes a warning.
   */
  private async loadIndex(
    request: BacktestRequest,
    candles: Record<string, HistoricalCandle[]>,
    warnings: string[],
  ): Promise<SimulationInput["index"]> {
    const symbol = request.benchmarkSymbol?.trim().toUpperCase();
    if (!symbol) return undefined;
    if (candles[symbol]) return { symbol, candles: candles[symbol] };
    try {
      const bars = await this.historicalData.getHistoricalData({
        symbol,
        interval: "1day",
        fromDate: request.from,
        toDate: request.to,
      });
      const { candles: clean, removed } = cleanCandles(bars);
      const note = badBarsNote(symbol, removed);
      if (note) warnings.push(note);
      return { symbol, candles: clean };
    } catch (error) {
      warnings.push(`Index benchmark ${symbol} unavailable (${(error as Error).message}), skipped`);
      return undefined;
    }
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
