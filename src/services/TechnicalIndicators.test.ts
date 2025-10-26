import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HistoricalCandle } from "../types";
import TechnicalIndicators from "./TechnicalIndicators";

const createMockCandles = (prices: number[]): HistoricalCandle[] => {
  return prices.map((price, index) => ({
    symbol: "TEST",
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 10000,
    timestamp: new Date(Date.now() + index * 24 * 60 * 60 * 1000),
  }));
};

describe("TechnicalIndicators", () => {
  describe("calculateSMA", () => {
    it("calculates simple moving average correctly", () => {
      const candles = createMockCandles([10, 12, 14, 16, 18]);
      const sma = TechnicalIndicators.calculateSMA(candles, 3);

      // Last 3 prices: 14, 16, 18 -> average = 16
      assert.equal(sma, 16);
    });

    it("returns undefined when insufficient data", () => {
      const candles = createMockCandles([10, 12]);
      const sma = TechnicalIndicators.calculateSMA(candles, 5);

      assert.equal(sma, undefined);
    });
  });

  describe("calculateEMA", () => {
    it("calculates exponential moving average", () => {
      const candles = createMockCandles([10, 12, 14, 16, 18]);
      const ema = TechnicalIndicators.calculateEMA(candles, 3);

      assert.equal(typeof ema, "number");
      assert.ok(ema! > 0);
    });

    it("returns undefined when insufficient data", () => {
      const candles = createMockCandles([10]);
      const ema = TechnicalIndicators.calculateEMA(candles, 5);

      assert.equal(ema, undefined);
    });
  });

  describe("calculateRSI", () => {
    it("calculates RSI for trending data", () => {
      // Create uptrending data
      const candles = createMockCandles([100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122, 124, 126, 128]);
      const rsi = TechnicalIndicators.calculateRSI(candles, 14);

      assert.equal(typeof rsi, "number");
      assert.ok(rsi! > 50); // Should be above 50 for uptrend
      assert.ok(rsi! <= 100);
    });

    it("returns undefined when insufficient data", () => {
      const candles = createMockCandles([100, 102, 104]);
      const rsi = TechnicalIndicators.calculateRSI(candles, 14);

      assert.equal(rsi, undefined);
    });
  });

  describe("calculateMACD", () => {
    it("calculates MACD values", () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
      const candles = createMockCandles(prices);
      const macd = TechnicalIndicators.calculateMACD(candles);

      assert.equal(typeof macd?.macd, "number");
      assert.equal(typeof macd?.signal, "number");
      assert.equal(typeof macd?.histogram, "number");
    });

    it("returns undefined when insufficient data", () => {
      const candles = createMockCandles([100, 102, 104]);
      const macd = TechnicalIndicators.calculateMACD(candles);

      assert.equal(macd, undefined);
    });
  });

  describe("calculateBollingerBands", () => {
    it("calculates Bollinger Bands", () => {
      const prices = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i * 0.1) * 5);
      const candles = createMockCandles(prices);
      const bands = TechnicalIndicators.calculateBollingerBands(candles);

      assert.equal(typeof bands?.upper, "number");
      assert.equal(typeof bands?.middle, "number");
      assert.equal(typeof bands?.lower, "number");
      assert.ok(bands!.upper > bands!.middle);
      assert.ok(bands!.middle > bands!.lower);
    });

    it("returns undefined when insufficient data", () => {
      const candles = createMockCandles([100, 102]);
      const bands = TechnicalIndicators.calculateBollingerBands(candles);

      assert.equal(bands, undefined);
    });
  });

  describe("analyzeVolatility", () => {
    it("analyzes volatility correctly", () => {
      const prices = [100, 105, 95, 110, 90, 108, 92, 115, 85, 120, 95, 105, 98, 112, 88, 118, 92, 108, 96, 114];
      const candles = createMockCandles(prices);
      const analysis = TechnicalIndicators.analyzeVolatility(candles);

      assert.equal(typeof analysis.volatility, "number");
      assert.equal(typeof analysis.averageVolume, "number");
      assert.equal(typeof analysis.priceRange.high, "number");
      assert.equal(typeof analysis.priceRange.low, "number");
      assert.ok(analysis.volatility > 0);
      assert.ok(analysis.priceRange.high > analysis.priceRange.low);
    });

    it("throws error when insufficient data", () => {
      const candles = createMockCandles([100, 102]);

      assert.throws(() => {
        TechnicalIndicators.analyzeVolatility(candles, 20);
      });
    });
  });

  describe("detectTrend", () => {
    it("detects bullish trend", () => {
      const prices = Array.from({ length: 35 }, (_, i) => 100 + i * 0.5); // Uptrending
      const candles = createMockCandles(prices);
      const trend = TechnicalIndicators.detectTrend(candles);

      assert.equal(trend.trend, "BULLISH");
      assert.equal(typeof trend.strength, "number");
      assert.ok(trend.shortMA > trend.longMA);
    });

    it("detects bearish trend", () => {
      const prices = Array.from({ length: 35 }, (_, i) => 130 - i * 0.5); // Downtrending
      const candles = createMockCandles(prices);
      const trend = TechnicalIndicators.detectTrend(candles);

      assert.equal(trend.trend, "BEARISH");
      assert.ok(trend.shortMA < trend.longMA);
    });

    it("detects sideways trend", () => {
      const prices = Array.from({ length: 35 }, () => 100 + (Math.random() - 0.5) * 2); // Sideways
      const candles = createMockCandles(prices);
      const trend = TechnicalIndicators.detectTrend(candles);

      // Should be either SIDEWAYS or have low strength
      assert.ok(trend.trend === "SIDEWAYS" || trend.strength < 0.05);
    });
  });

  describe("getStandardIndicators", () => {
    it("calculates all standard indicators", () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
      const candles = createMockCandles(prices);
      const indicators = TechnicalIndicators.getStandardIndicators(candles);

      assert.equal(typeof indicators.sma, "number");
      assert.equal(typeof indicators.ema, "number");
      assert.equal(typeof indicators.rsi, "number");
      assert.equal(typeof indicators.macd?.macd, "number");
      assert.equal(typeof indicators.bollinger?.upper, "number");
    });
  });
});