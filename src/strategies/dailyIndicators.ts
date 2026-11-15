import { IncrementalEMA, IncrementalRSI, IncrementalSMA } from "../services/IncrementalIndicators";
import type { HistoricalCandle } from "../types";

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
