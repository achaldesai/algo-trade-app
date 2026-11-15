import type { HistoricalCandle } from "../types";

/** A close this far from the last good close starts a suspected bad run. */
const JUMP = 0.5;
/** The run is bad only if price is back within this of the last good close... */
const RETURN_BAND = 0.15;
/** ...within this many bars after the jump. */
const MAX_BAD_RUN = 3;

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export interface CleanedCandles {
  candles: HistoricalCandle[];
  /** Dates (YYYY-MM-DD) of the bars that were removed, oldest first. */
  removed: string[];
}

/**
 * Remove bad bars: short spikes where the close jumps more than 50% away from
 * the last good close and comes back within 15% of it within 3 bars (e.g.
 * Yahoo's NIFTYBEES at ₹13 instead of ₹130 on 2019-12-19/20, a split applied
 * to two days only). Real crashes and re-ratings don't snap back, so they are
 * kept. A spike in the last bars can't be confirmed yet and is kept too.
 *
 * Returns new arrays, sorted oldest first; the input is not modified.
 */
export function cleanCandles(input: HistoricalCandle[]): CleanedCandles {
  const bars = [...input].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const candles: HistoricalCandle[] = [];
  const removed: string[] = [];

  let i = 0;
  while (i < bars.length) {
    const ref = candles.at(-1)?.close;
    const isJump = ref !== undefined && ref > 0 && Math.abs(bars[i].close / ref - 1) > JUMP;
    if (isJump) {
      const back = bars
        .slice(i + 1, i + 1 + MAX_BAD_RUN)
        .findIndex((b) => Math.abs(b.close / ref - 1) <= RETURN_BAND);
      if (back !== -1) {
        for (const bar of bars.slice(i, i + 1 + back)) removed.push(dayKey(bar.timestamp));
        i += 1 + back;
        continue;
      }
    }
    candles.push(bars[i]);
    i++;
  }
  return { candles, removed };
}

/** Human-readable note for a symbol's removed bars, or undefined if none. */
export function badBarsNote(symbol: string, removed: string[]): string | undefined {
  if (removed.length === 0) return undefined;
  const plural = removed.length === 1 ? "bar" : "bars";
  return `${symbol}: removed ${removed.length} bad ${plural} (${removed.join(", ")}): price spiked and snapped back, likely a data error`;
}
