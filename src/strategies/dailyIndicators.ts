import { IncrementalEMA, IncrementalRSI, IncrementalSMA } from "../services/IncrementalIndicators";
import type { HistoricalCandle } from "../types";
import type { StrategyAccount, StrategyParamDefinition } from "./BaseStrategy";

interface Indicator {
  update(price: number): unknown;
  readonly value: number | undefined;
}

/**
 * Feed closes through a fresh incremental indicator and return its last two
 * values ([previous, current]). Either is undefined until the indicator has
 * warmed up. Daily strategies call this per evaluation instead of keeping
 * indicator state, so evaluations are independent and replayable.
 */
export function lastTwo(indicator: Indicator, bars: HistoricalCandle[]): [number | undefined, number | undefined] {
  let previous: number | undefined;
  for (let i = 0; i < bars.length; i++) {
    if (i === bars.length - 1) previous = indicator.value;
    indicator.update(bars[i].close);
  }
  return [previous, indicator.value];
}

export function movingAverage(type: "sma" | "ema", period: number): Indicator {
  return type === "ema" ? new IncrementalEMA(period) : new IncrementalSMA(period);
}

export function rsi(period: number): Indicator {
  return new IncrementalRSI(period);
}

/** Read a numeric param, falling back to the default for missing or non-finite values. */
export function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(params[key]);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Calendar date far enough before `date` to cover `warmupBars` trading days
 * (~1.5 calendar days each, plus slack for holidays).
 */
export function warmupFetchStart(date: Date, warmupBars: number): Date {
  const start = new Date(date);
  start.setDate(start.getDate() - Math.ceil(warmupBars * 1.5) - 10);
  return start;
}

// ─── Position sizing ─────────────────────────────────────────────────────────

export type SizingMode = "shares" | "percent";

const DEFAULT_SIZING: SizingMode = "shares";
const DEFAULT_POSITION_PCT = 25;
const DEFAULT_ORDER_SIZE = 10;
/** Share of cash percent sizing leaves unspent, so costs and slippage still fit. */
export const CASH_BUFFER = 0.005;

/** Sizing params shared by the daily strategies; append to their schemas. */
export const SIZING_PARAM_SCHEMA: StrategyParamDefinition[] = [
  {
    key: "sizing",
    label: "Position Sizing",
    type: "select",
    default: DEFAULT_SIZING,
    options: [
      { value: "shares", label: "Fixed number of shares" },
      { value: "percent", label: "% of account equity" },
    ],
  },
  {
    key: "positionPct",
    label: "Position Size (% of equity)",
    type: "number",
    default: DEFAULT_POSITION_PCT,
    description: "Each new position uses this share of equity, capped at the cash available",
    min: 1,
    max: 100,
    step: 1,
    visibleWhen: { key: "sizing", equals: "percent" },
  },
  {
    key: "orderSize",
    label: "Order Size (shares)",
    type: "number",
    default: DEFAULT_ORDER_SIZE,
    min: 1,
    max: 10000,
    step: 1,
    visibleWhen: { key: "sizing", equals: "shares" },
  },
];

export const DEFAULT_SIZING_PARAMS = {
  sizing: DEFAULT_SIZING,
  positionPct: DEFAULT_POSITION_PCT,
  orderSize: DEFAULT_ORDER_SIZE,
};

/**
 * Returns a function giving the number of shares to buy at `price`, for one
 * evaluation. In "percent" mode it sizes from `account` and spends down a local
 * copy of the cash, so several buys in the same evaluation can't overspend.
 * Without `account` it returns 0: percent sizing never falls back to a share
 * count, which could place a wrongly sized live order. It keeps CASH_BUFFER of
 * the cash unspent so costs and slippage fit.
 */
/** Order fields for a buy: percent-sized buys may be resized to fit cash. */
export function buyOrderFlags(params: Record<string, unknown>): { sizeToCash?: true } {
  return params.sizing === "percent" ? { sizeToCash: true } : {};
}

/** Why a buy signal sized to 0 shares, for StrategySignal.skippedReason. */
export function buySkipReason(params: Record<string, unknown>, account?: StrategyAccount): string {
  return params.sizing === "percent" && !account
    ? "No account balance for % of equity sizing"
    : "Position budget below one share";
}

export function buySizer(params: Record<string, unknown>, account?: StrategyAccount): (price: number) => number {
  if (params.sizing !== "percent") {
    const orderSize = numberParam(params, "orderSize", DEFAULT_ORDER_SIZE);
    return () => orderSize;
  }
  if (!account) return () => 0;

  const budget = (numberParam(params, "positionPct", DEFAULT_POSITION_PCT) / 100) * account.equity;
  let cash = account.cash * (1 - CASH_BUFFER);
  return (price) => {
    if (!(price > 0)) return 0;
    const quantity = Math.max(0, Math.floor(Math.min(budget, cash) / price));
    cash -= quantity * price;
    return quantity;
  };
}
