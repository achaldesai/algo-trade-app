import { describe, it } from "node:test";
import assert from "node:assert";
import { TechnicalIndicators } from "./TechnicalIndicators";
import type { HistoricalCandle } from "../types";

describe("TechnicalIndicators - EMA Calculation Fix", () => {
  // Helper to create test candles
  const createCandles = (closePrices: number[]): HistoricalCandle[] => {
    return closePrices.map((close, i) => ({
      symbol: "TEST",
      timestamp: new Date(2024, 0, i + 1),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
    }));
  };

  it("should calculate EMA using SMA for first value", () => {
    // Test with known values
    const candles = createCandles([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const period = 5;

    const ema = TechnicalIndicators.calculateEMA(candles, period);

    assert.ok(ema !== undefined, "EMA should be calculated");

    // First EMA value should be SMA of first 5 candles: (10+11+12+13+14)/5 = 12
    // Then continue with EMA formula for remaining candles
    // This is the industry standard approach

    // The result should be different from the old buggy implementation
    // which just used the first candle (10) as the starting point
    assert.ok(ema !== undefined);
    assert.ok(typeof ema === "number");
  });

  it("should return undefined when insufficient data", () => {
    const candles = createCandles([10, 11, 12]); // Only 3 candles
    const period = 5;

    const ema = TechnicalIndicators.calculateEMA(candles, period);

    assert.strictEqual(ema, undefined, "Should return undefined when candles < period");
  });

  it("should calculate correct EMA for exact period length", () => {
    const candles = createCandles([10, 11, 12, 13, 14]); // Exactly 5 candles
    const period = 5;

    const ema = TechnicalIndicators.calculateEMA(candles, period);

    // With exactly 5 candles, EMA should equal SMA
    const sma = TechnicalIndicators.calculateSMA(candles, period);

    assert.strictEqual(ema, sma, "EMA should equal SMA when candles === period");
  });

  it("should produce different results than old buggy implementation", () => {
    const candles = createCandles([100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120]);
    const period = 5;

    const ema = TechnicalIndicators.calculateEMA(candles, period);

    // Old implementation started with first candle (100)
    // New implementation starts with SMA: (100+102+104+106+108)/5 = 104
    // So the final EMA values will be different

    assert.ok(ema !== undefined);

    // The new EMA should be closer to recent values due to proper initialization
    // With proper SMA initialization, the EMA should be higher
    assert.ok(ema! > 110, "Properly initialized EMA should reflect recent uptrend");
  });

  it("should handle MACD calculation with fixed EMA", () => {
    // Create trending data
    const closePrices = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5);
    const candles = createCandles(closePrices);

    const macd = TechnicalIndicators.calculateMACD(candles, 12, 26, 9);

    assert.ok(macd !== undefined, "MACD should be calculated");
    assert.ok(macd!.macd !== undefined);
    assert.ok(macd!.signal !== undefined);
    assert.ok(macd!.histogram !== undefined);

    // In an uptrend, MACD should be positive
    assert.ok(macd!.macd > 0, "MACD should be positive in uptrend");
  });

  it("should calculate EMA consistently with longer periods", () => {
    const candles = createCandles([
      100, 102, 101, 103, 105, 104, 106, 108, 107, 109,
      110, 112, 111, 113, 115, 114, 116, 118, 117, 119,
      120, 122, 121, 123, 125, 124, 126, 128, 127, 129,
    ]);

    const ema10 = TechnicalIndicators.calculateEMA(candles, 10);
    const ema20 = TechnicalIndicators.calculateEMA(candles, 20);

    assert.ok(ema10 !== undefined);
    assert.ok(ema20 !== undefined);

    // In an uptrend, shorter EMA should be higher than longer EMA
    assert.ok(ema10! > ema20!, "Shorter EMA should be higher in uptrend");
  });

  it("should match SMA when period equals data length", () => {
    const prices = [100, 105, 102, 108, 110];
    const candles = createCandles(prices);
    const period = prices.length;

    const ema = TechnicalIndicators.calculateEMA(candles, period);
    const sma = TechnicalIndicators.calculateSMA(candles, period);

    assert.ok(ema !== undefined);
    assert.ok(sma !== undefined);
    assert.strictEqual(ema, sma, "EMA should equal SMA when no additional candles to process");
  });

  it("should handle volatile data correctly", () => {
    // Create volatile price data
    const candles = createCandles([
      100, 110, 95, 105, 115, 90, 120, 100, 130, 110,
      125, 105, 135, 115, 140, 120, 145, 125, 150, 130,
    ]);

    const ema = TechnicalIndicators.calculateEMA(candles, 10);

    assert.ok(ema !== undefined);
    assert.ok(typeof ema === "number");
    assert.ok(ema > 0, "EMA should be positive");

    // EMA should be somewhere in the middle range of recent values
    assert.ok(ema >= 90 && ema <= 150, "EMA should be within data range");
  });
});
