import YahooFinance from "yahoo-finance2";
import { DelistedSymbolError, type HistoricalDataProvider } from "../services/HistoricalDataService";
import type { HistoricalCandle, HistoricalDataRequest } from "../types";
import logger from "../utils/logger";

function isYahooNoDataError(error: unknown): boolean {
  return error instanceof Error && /no data found/i.test(error.message);
}

const yahooFinance = new YahooFinance();

export interface YahooHistoricalConfig {
  defaultExchange?: "NSE" | "BSE";
}

const INTERVAL_MAP: Record<HistoricalDataRequest["interval"], "1d" | "1wk" | "1mo"> = {
  "1day": "1d",
  "1week": "1wk",
  "1month": "1mo",
};

const EXCHANGE_SUFFIX: Record<string, string> = {
  NSE: ".NS",
  BSE: ".BO",
};

// Free, unauthenticated NSE/BSE historical via Yahoo Finance.
// Bare symbols like "RELIANCE" get the exchange suffix appended (.NS for NSE).
// Symbols already suffixed (e.g. "RELIANCE.NS") pass through unchanged.
export class YahooHistoricalProvider implements HistoricalDataProvider {
  private readonly defaultSuffix: string;

  constructor(config: YahooHistoricalConfig = {}) {
    const exchange = (config.defaultExchange ?? "NSE").toUpperCase();
    this.defaultSuffix = EXCHANGE_SUFFIX[exchange] ?? ".NS";
  }

  async fetchHistoricalData(request: HistoricalDataRequest): Promise<HistoricalCandle[]> {
    const yahooSymbol = this.toYahooSymbol(request.symbol);
    const interval = INTERVAL_MAP[request.interval];

    logger.info(
      {
        symbol: request.symbol,
        yahooSymbol,
        interval: request.interval,
        from: request.fromDate,
        to: request.toDate,
      },
      "Fetching historical data from Yahoo Finance",
    );

    try {
      const result = await yahooFinance.chart(yahooSymbol, {
        period1: request.fromDate,
        period2: request.toDate,
        interval,
        return: "array",
      });

      return result.quotes
        .filter(
          (q): q is typeof q & { open: number; high: number; low: number; close: number; volume: number } =>
            q.open !== null &&
            q.high !== null &&
            q.low !== null &&
            q.close !== null &&
            q.volume !== null,
        )
        .map((q) => ({
          symbol: request.symbol,
          open: q.open,
          high: q.high,
          low: q.low,
          close: q.close,
          volume: q.volume,
          timestamp: q.date,
        }));
    } catch (error) {
      if (isYahooNoDataError(error)) {
        logger.warn(
          { symbol: request.symbol, yahooSymbol, interval: request.interval },
          "Yahoo Finance has no data for symbol — treating as delisted/unsupported",
        );
        throw new DelistedSymbolError(request.symbol, (error as Error).message);
      }
      logger.error(
        { err: error, symbol: request.symbol, yahooSymbol, interval: request.interval },
        "Error fetching historical data from Yahoo Finance",
      );
      throw error;
    }
  }

  private toYahooSymbol(symbol: string): string {
    return symbol.includes(".") ? symbol : `${symbol}${this.defaultSuffix}`;
  }
}

export default YahooHistoricalProvider;
