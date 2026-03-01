import { HistoricalDataService } from "./HistoricalDataService";
import { InstrumentMasterService, getInstrumentMasterService } from "./InstrumentMasterService";
import logger from "../utils/logger";
import { TechnicalIndicators } from "./TechnicalIndicators";
import type TickerClient from "./TickerClient";

export interface ScanResult {
  symbol: string;
  score: number;
  reason: string[];
  metrics: {
    price: number;
    atrPercent: number;
    volumeRatio: number;
    dailyRangePercent: number;
  };
}

export class MarketScannerService {
  public readonly instrumentService: InstrumentMasterService;
  private readonly historicalDataService: HistoricalDataService;

  // Nifty 50 + highly liquid midcaps for better volatility
  private readonly UNIVERSE = [
    "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "HINDUNILVR", "ITC", "SBIN", "BHARTIARTL", "KOTAKBANK",
    "LTIM", "AXISBANK", "BAJFINANCE", "ASIANPAINT", "MARUTI", "HCLTECH", "SUNPHARMA", "TITAN", "ULTRACEMCO", "TATASTEEL",
    "NTPC", "POWERGRID", "BAJAJFINSV", "INDUSINDBK", "NESTLEIND", "JSWSTEEL", "ADANIENT", "GRASIM", "TECHM", "ONGC",
    "HINDALCO", "WIPRO", "COALINDIA", "DIVISLAB", "ADANIPORTS", "CIPLA", "APOLLOHOSP", "DRREDDY", "M&M", "TATAMOTORS",
    "EICHERMOT", "BRITANNIA", "BAJAJ-AUTO", "HEROMOTOCO", "SBILIFE", "HDFCLIFE", "BPCL", "TATACONSUM", "UPL",
    "ADANIGREEN", "ADANIPOWER", "DLF", "HAL", "TATAELXSI", "TRENT", "VBL", "ZOMATO", "CANBK", "IDFCFIRSTB"
  ];

  constructor(
    historicalDataService: HistoricalDataService,
    instrumentService?: InstrumentMasterService
  ) {
    this.historicalDataService = historicalDataService;
    this.instrumentService = instrumentService || getInstrumentMasterService();
  }

  /**
   * Scan the market for high-volatility, high-volume stocks suitable for day trading
   */
  async scan(limit: number = 10): Promise<ScanResult[]> {
    logger.info({ universeSize: this.UNIVERSE.length }, "Starting intraday market scan...");

    if (!this.instrumentService.isReady()) {
      await this.instrumentService.loadInstrumentMaster();
    }

    const results: ScanResult[] = [];

    // Concurrency limit to avoid rate limiting
    const batchSize = 5;
    for (let i = 0; i < this.UNIVERSE.length; i += batchSize) {
      const batch = this.UNIVERSE.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(symbol => this.analyzeForIntraday(symbol))
      );

      for (const result of batchResults) {
        if (result.status === "fulfilled" && result.value) {
          results.push(result.value);
        }
      }
    }

    // Sort by score (Volatility + Volume + Trend)
    const sortedResults = results.sort((a, b) => b.score - a.score).slice(0, limit);

    logger.info(
      {
        scanned: this.UNIVERSE.length,
        selected: sortedResults.length,
        topPicks: sortedResults.map(r => r.symbol)
      },
      "Intraday market scan completed"
    );

    return sortedResults;
  }

  private async analyzeForIntraday(symbol: string): Promise<ScanResult | null> {
    try {
      // Need at least 30 days of data for ATR and SMA
      const candles = await this.historicalDataService.getRecentData(symbol, 40);

      if (candles.length < 25) return null;

      const latest = candles[candles.length - 1];
      const volumes = candles.map(c => c.volume);

      // 1. ATR % Calculation (Volatility)
      const trueRanges = candles.slice(1).map((c, i) => {
        const prevC = candles[i].close;
        return Math.max(c.high - c.low, Math.abs(c.high - prevC), Math.abs(c.low - prevC));
      });
      const recentTR = trueRanges.slice(-14);
      const currentAtr = recentTR.reduce((sum, val) => sum + val, 0) / (recentTR.length || 1);
      const atrPercent = (currentAtr / latest.close) * 100;

      // 2. Relative Volume (RVOL)
      const recentVolumes = volumes.slice(-20);
      const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / (recentVolumes.length || 1);
      const volumeRatio = latest.volume / avgVolume;

      // 3. Daily Range %
      const dailyRangePercent = ((latest.high - latest.low) / latest.low) * 100;

      // 4. Trend Filter (Price > 20 SMA)
      const sma20 = TechnicalIndicators.calculateSMA(candles, 20);
      const isShortTermBullish = sma20 !== undefined && latest.close > sma20;

      // DAY TRADING CRITERIA:
      // - High ATR % (> 1.2% for movement)
      // - High RVOL (> 0.8 for interest)
      // - Bullish Trend

      if (atrPercent > 1.2 && volumeRatio > 0.8 && isShortTermBullish) {
        // Scoring: 40% ATR%, 40% RVOL, 20% Range
        const score = (atrPercent * 4) + (volumeRatio * 4) + (dailyRangePercent * 2);

        return {
          symbol,
          score,
          reason: [
            `High Volatility (ATR ${atrPercent.toFixed(2)}%)`,
            `Active Interest (RVOL ${volumeRatio.toFixed(2)})`,
            `Bullish Setup (> 20 SMA)`
          ],
          metrics: {
            price: latest.close,
            atrPercent,
            volumeRatio,
            dailyRangePercent
          }
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Automatically subscribe to picked stocks
   */
  async applyPicks(picks: ScanResult[], tickerClient: TickerClient): Promise<void> {
    if (picks.length === 0) {
      logger.warn("No stocks picked to apply");
      return;
    }

    let subscribedCount = 0;
    for (const pick of picks) {
      const token = this.instrumentService.getToken(pick.symbol, "NSE");
      if (token) {
        tickerClient.subscribe({
          exchange: "NSE",
          symbolToken: token,
          symbol: pick.symbol
        });
        subscribedCount++;
      } else {
        logger.warn({ symbol: pick.symbol }, "Failed to subscribe to picked stock: Token not found");
      }
    }

    logger.info({ count: subscribedCount }, "Subscribed to automatically picked stocks");
  }
}

export default MarketScannerService;
