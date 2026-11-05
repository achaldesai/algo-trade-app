import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IncrementalEMA,
  IncrementalSMA,
  IncrementalRSI,
  IncrementalBollingerBands,
} from "./IncrementalIndicators";

// Deterministic random-walk price series (LCG) so failures are reproducible.
function priceSeries(length: number, seed = 42): number[] {
  let state = seed;
  let price = 2500;
  const prices: number[] = [];
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    price += ((state / 2 ** 32) - 0.5) * 20;
    prices.push(Number(price.toFixed(2)));
  }
  return prices;
}

// ── From-scratch reference implementations ──────────────────────────────────

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function referenceSMA(prices: number[], period: number, i: number): number | undefined {
  if (i + 1 < period) return undefined;
  return mean(prices.slice(i + 1 - period, i + 1));
}

function referenceEMA(prices: number[], period: number, i: number): number | undefined {
  if (i + 1 < period) return undefined;
  const k = 2 / (period + 1);
  let ema = mean(prices.slice(0, period));
  for (let j = period; j <= i; j++) ema = (prices[j] - ema) * k + ema;
  return ema;
}

function referenceRSI(prices: number[], period: number, i: number): number | undefined {
  if (i < period) return undefined;
  let avgGain = 0;
  let avgLoss = 0;
  for (let j = 1; j <= period; j++) {
    const change = prices[j] - prices[j - 1];
    avgGain += Math.max(change, 0);
    avgLoss += Math.max(-change, 0);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let j = period + 1; j <= i; j++) {
    const change = prices[j] - prices[j - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function referenceBollinger(prices: number[], period: number, mult: number, i: number) {
  if (i + 1 < period) return undefined;
  const window = prices.slice(i + 1 - period, i + 1);
  const middle = mean(window);
  const stdDev = Math.sqrt(mean(window.map((p) => (p - middle) ** 2)));
  return { upper: middle + mult * stdDev, middle, lower: middle - mult * stdDev };
}

function assertClose(actual: number | undefined, expected: number | undefined, label: string) {
  if (expected === undefined) {
    assert.equal(actual, undefined, `${label}: expected undefined`);
    return;
  }
  assert.ok(actual !== undefined, `${label}: expected ${expected}, got undefined`);
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: expected ${expected}, got ${actual}`);
}

// ── Tests ────────────────────────────────────────────────────────────────────

const prices = priceSeries(300);

describe("IncrementalIndicators match from-scratch computation", () => {
  it("SMA", () => {
    const sma = new IncrementalSMA(20);
    prices.forEach((p, i) => assertClose(sma.update(p), referenceSMA(prices, 20, i), `SMA@${i}`));
  });

  it("EMA (SMA-seeded)", () => {
    const ema = new IncrementalEMA(12);
    prices.forEach((p, i) => assertClose(ema.update(p), referenceEMA(prices, 12, i), `EMA@${i}`));
  });

  it("RSI (Wilder smoothing)", () => {
    const rsi = new IncrementalRSI(14);
    prices.forEach((p, i) => assertClose(rsi.update(p), referenceRSI(prices, 14, i), `RSI@${i}`));
  });

  it("Bollinger Bands", () => {
    const bb = new IncrementalBollingerBands(20, 2);
    prices.forEach((p, i) => {
      const actual = bb.update(p);
      const expected = referenceBollinger(prices, 20, 2, i);
      assertClose(actual?.upper, expected?.upper, `BB.upper@${i}`);
      assertClose(actual?.middle, expected?.middle, `BB.middle@${i}`);
      assertClose(actual?.lower, expected?.lower, `BB.lower@${i}`);
    });
  });

  it("RSI is 100 on a strictly rising series", () => {
    const rsi = new IncrementalRSI(14);
    let last: number | undefined;
    for (let i = 0; i < 30; i++) last = rsi.update(100 + i);
    assert.equal(last, 100);
  });

  it("reset() returns indicators to the warm-up state", () => {
    const sma = new IncrementalSMA(5);
    prices.slice(0, 10).forEach((p) => sma.update(p));
    sma.reset();
    assert.equal(sma.isReady, false);
    assert.equal(sma.value, undefined);
  });
});
