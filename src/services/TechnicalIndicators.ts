import type { HistoricalCandle, TechnicalIndicatorValues } from "../types";

export class TechnicalIndicators {
  static calculateSMA(candles: HistoricalCandle[], period: number): number | undefined {
    if (candles.length < period) {
      return undefined;
    }

    const recentCandles = candles.slice(-period);
    const sum = recentCandles.reduce((total, candle) => total + candle.close, 0);
    return Number((sum / period).toFixed(4));
  }

  static calculateEMA(candles: HistoricalCandle[], period: number): number | undefined {
    if (candles.length < period) {
      return undefined;
    }

    const multiplier = 2 / (period + 1);

    // Use SMA for the first EMA value (industry standard)
    const firstCandles = candles.slice(0, period);
    let ema = firstCandles.reduce((sum, candle) => sum + candle.close, 0) / period;

    // Calculate EMA for remaining candles
    for (let i = period; i < candles.length; i++) {
      ema = (candles[i].close * multiplier) + (ema * (1 - multiplier));
    }

    return Number(ema.toFixed(4));
  }

  static calculateRSI(candles: HistoricalCandle[], period: number = 14): number | undefined {
    if (candles.length < period + 1) {
      return undefined;
    }

    const gains: number[] = [];
    const losses: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const change = candles[i].close - candles[i - 1].close;
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? Math.abs(change) : 0);
    }

    const recentGains = gains.slice(-period);
    const recentLosses = losses.slice(-period);

    const avgGain = recentGains.reduce((sum, gain) => sum + gain, 0) / period;
    const avgLoss = recentLosses.reduce((sum, loss) => sum + loss, 0) / period;

    if (avgLoss === 0) {
      return 100;
    }

    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    return Number(rsi.toFixed(2));
  }

  static calculateMACD(
    candles: HistoricalCandle[],
    fastPeriod: number = 12,
    slowPeriod: number = 26,
    signalPeriod: number = 9
  ): { macd: number; signal: number; histogram: number } | undefined {
    if (candles.length < slowPeriod) {
      return undefined;
    }

    const fastMultiplier = 2 / (fastPeriod + 1);
    const slowMultiplier = 2 / (slowPeriod + 1);
    const signalMultiplier = 2 / (signalPeriod + 1);

    // Calculate initial SMA values for fast and slow EMAs
    let fastEMA = candles.slice(0, fastPeriod).reduce((sum, c) => sum + c.close, 0) / fastPeriod;
    let slowEMA = candles.slice(0, slowPeriod).reduce((sum, c) => sum + c.close, 0) / slowPeriod;

    const macdValues: number[] = [];

    // Calculate MACD values incrementally (O(n) instead of O(n²))
    for (let i = slowPeriod; i < candles.length; i++) {
      // Update fast EMA
      fastEMA = (candles[i].close * fastMultiplier) + (fastEMA * (1 - fastMultiplier));

      // Update slow EMA
      slowEMA = (candles[i].close * slowMultiplier) + (slowEMA * (1 - slowMultiplier));

      // Calculate MACD line
      macdValues.push(fastEMA - slowEMA);
    }

    if (macdValues.length === 0) {
      return undefined;
    }

    const macd = macdValues[macdValues.length - 1];

    if (macdValues.length < signalPeriod) {
      return {
        macd: Number(macd.toFixed(4)),
        signal: Number(macd.toFixed(4)),
        histogram: 0,
      };
    }

    // Calculate signal line (EMA of MACD) - use SMA for first value
    const firstMacdValues = macdValues.slice(0, signalPeriod);
    let signal = firstMacdValues.reduce((sum, val) => sum + val, 0) / signalPeriod;

    for (let i = signalPeriod; i < macdValues.length; i++) {
      signal = (macdValues[i] * signalMultiplier) + (signal * (1 - signalMultiplier));
    }

    const histogram = macd - signal;

    return {
      macd: Number(macd.toFixed(4)),
      signal: Number(signal.toFixed(4)),
      histogram: Number(histogram.toFixed(4)),
    };
  }

  static calculateBollingerBands(
    candles: HistoricalCandle[],
    period: number = 20,
    stdDev: number = 2
  ): { upper: number; middle: number; lower: number } | undefined {
    const sma = this.calculateSMA(candles, period);
    if (!sma || candles.length < period) {
      return undefined;
    }

    const recentCandles = candles.slice(-period);
    const variance = recentCandles.reduce((sum, candle) => {
      return sum + Math.pow(candle.close - sma, 2);
    }, 0) / period;

    const standardDeviation = Math.sqrt(variance);
    const offset = standardDeviation * stdDev;

    return {
      upper: Number((sma + offset).toFixed(4)),
      middle: sma,
      lower: Number((sma - offset).toFixed(4)),
    };
  }

  static calculateAllIndicators(
    candles: HistoricalCandle[],
    options: {
      sma?: number;
      ema?: number;
      rsi?: number;
      macd?: { fast: number; slow: number; signal: number };
      bollinger?: { period: number; stdDev: number };
    } = {}
  ): TechnicalIndicatorValues {
    const indicators: TechnicalIndicatorValues = {};

    if (options.sma) {
      indicators.sma = this.calculateSMA(candles, options.sma);
    }

    if (options.ema) {
      indicators.ema = this.calculateEMA(candles, options.ema);
    }

    if (options.rsi) {
      indicators.rsi = this.calculateRSI(candles, options.rsi);
    }

    if (options.macd) {
      indicators.macd = this.calculateMACD(
        candles,
        options.macd.fast,
        options.macd.slow,
        options.macd.signal
      );
    }

    if (options.bollinger) {
      indicators.bollinger = this.calculateBollingerBands(
        candles,
        options.bollinger.period,
        options.bollinger.stdDev
      );
    }

    return indicators;
  }

  static getStandardIndicators(candles: HistoricalCandle[]): TechnicalIndicatorValues {
    return this.calculateAllIndicators(candles, {
      sma: 20,
      ema: 20,
      rsi: 14,
      macd: { fast: 12, slow: 26, signal: 9 },
      bollinger: { period: 20, stdDev: 2 },
    });
  }

  static analyzeVolatility(candles: HistoricalCandle[], period: number = 20): {
    volatility: number;
    averageVolume: number;
    priceRange: { high: number; low: number };
  } {
    if (candles.length < period) {
      throw new Error(`Insufficient data for volatility analysis. Need ${period} candles, got ${candles.length}`);
    }

    const recentCandles = candles.slice(-period);

    // Calculate price volatility (standard deviation of returns)
    const returns = recentCandles.slice(1).map((candle, i) => {
      return (candle.close - recentCandles[i].close) / recentCandles[i].close;
    });

    const avgReturn = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - avgReturn, 2), 0) / returns.length;
    const volatility = Math.sqrt(variance) * Math.sqrt(252); // Annualized volatility

    // Calculate average volume
    const averageVolume = recentCandles.reduce((sum, candle) => sum + candle.volume, 0) / period;

    // Price range
    const high = Math.max(...recentCandles.map(c => c.high));
    const low = Math.min(...recentCandles.map(c => c.low));

    return {
      volatility: Number(volatility.toFixed(4)),
      averageVolume: Math.round(averageVolume),
      priceRange: { high, low },
    };
  }

  static detectTrend(candles: HistoricalCandle[], shortPeriod: number = 10, longPeriod: number = 30): {
    trend: "BULLISH" | "BEARISH" | "SIDEWAYS";
    strength: number;
    shortMA: number;
    longMA: number;
  } {
    const shortMA = this.calculateSMA(candles, shortPeriod);
    const longMA = this.calculateSMA(candles, longPeriod);

    if (!shortMA || !longMA) {
      throw new Error(`Insufficient data for trend analysis. Need ${longPeriod} candles`);
    }

    const difference = shortMA - longMA;
    const percentDiff = Math.abs(difference / longMA);

    let trend: "BULLISH" | "BEARISH" | "SIDEWAYS";
    if (percentDiff < 0.02) { // Less than 2% difference
      trend = "SIDEWAYS";
    } else if (difference > 0) {
      trend = "BULLISH";
    } else {
      trend = "BEARISH";
    }

    return {
      trend,
      strength: Number(percentDiff.toFixed(4)),
      shortMA,
      longMA,
    };
  }
}

export default TechnicalIndicators;