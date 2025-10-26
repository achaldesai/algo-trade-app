import { SmartAPI } from "smartapi-javascript";
import { authenticator } from "otplib";
import type { HistoricalDataProvider } from "../services/HistoricalDataService";
import type { HistoricalCandle, HistoricalDataRequest } from "../types";
import { getInstrumentMasterService } from "../services/InstrumentMasterService";
import logger from "../utils/logger";

export interface AngelOneConfig {
  apiKey: string;
  clientId: string;
  password: string;
  totpSecret?: string;
}

/**
 * Angel One SmartAPI provider for historical market data
 * Provides free access to historical OHLC data for Indian stocks
 */
export class AngelOneHistoricalProvider implements HistoricalDataProvider {
  private smartApi: typeof SmartAPI.prototype;
  private config: AngelOneConfig;
  private isAuthenticated = false;

  constructor(config: AngelOneConfig) {
    this.config = config;
    this.smartApi = new SmartAPI({
      api_key: config.apiKey,
    });
  }

  /**
   * Authenticate with Angel One SmartAPI
   * This should be called before fetching historical data
   */
  async authenticate(): Promise<void> {
    if (this.isAuthenticated) {
      return;
    }

    try {
      // Generate TOTP if totpSecret is provided
      const totp = this.config.totpSecret
        ? this.generateTOTP(this.config.totpSecret)
        : undefined;

      const loginResponse = await this.smartApi.generateSession(
        this.config.clientId,
        this.config.password,
        totp
      );

      if (loginResponse.status && loginResponse.data?.jwtToken) {
        this.smartApi.setAccessToken(loginResponse.data.jwtToken);
        this.isAuthenticated = true;
        logger.info("Angel One authentication successful");
      } else {
        throw new Error("Authentication failed: " + JSON.stringify(loginResponse));
      }
    } catch (error) {
      logger.error({ err: error }, "Failed to authenticate with Angel One");
      throw error;
    }
  }

  async fetchHistoricalData(request: HistoricalDataRequest): Promise<HistoricalCandle[]> {
    if (!this.isAuthenticated) {
      await this.authenticate();
    }

    try {
      const interval = this.mapInterval(request.interval);

      logger.info(
        {
          symbol: request.symbol,
          interval: request.interval,
          from: request.fromDate,
          to: request.toDate
        },
        "Fetching historical data from Angel One"
      );

      // Angel One historical API format
      const params = {
        exchange: "NSE", // TODO: Make this configurable
        symboltoken: await this.getSymbolToken(request.symbol),
        interval,
        fromdate: this.formatDate(request.fromDate),
        todate: this.formatDate(request.toDate),
      };

      const response = await this.smartApi.getCandleData(params);

      if (!response.status || !response.data) {
        throw new Error(`Failed to fetch historical data: ${JSON.stringify(response)}`);
      }

      return this.parseCandles(request.symbol, response.data);
    } catch (error) {
      logger.error(
        { err: error, symbol: request.symbol, interval: request.interval },
        "Error fetching historical data from Angel One"
      );
      throw error;
    }
  }

  /**
   * Get symbol token for a given symbol
   * Angel One requires instrument tokens instead of symbols
   */
  private async getSymbolToken(symbol: string): Promise<string> {
    const instrumentService = getInstrumentMasterService();

    // Ensure instrument master is loaded
    if (!instrumentService.isReady()) {
      try {
        await instrumentService.loadInstrumentMaster();
      } catch (error) {
        logger.error({ err: error, symbol }, "Failed to load instrument master");
        throw new Error(`Cannot fetch token for ${symbol}: instrument master not loaded`);
      }
    }

    // Get token from instrument service
    const token = instrumentService.getToken(symbol, "NSE");

    if (!token) {
      logger.error({ symbol }, "Symbol token not found in instrument master");
      throw new Error(`Symbol token not found for ${symbol}`);
    }

    return token;
  }

  /**
   * Map our interval format to Angel One's interval format
   */
  private mapInterval(interval: HistoricalDataRequest["interval"]): string {
    const intervalMap: Record<HistoricalDataRequest["interval"], string> = {
      "1day": "ONE_DAY",
      "1week": "ONE_WEEK",
      "1month": "ONE_MONTH",
    };

    return intervalMap[interval] || "ONE_DAY";
  }

  /**
   * Format date to Angel One's expected format (YYYY-MM-DD HH:mm)
   */
  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day} 09:15`; // Market opens at 9:15 AM IST
  }

  /**
   * Parse Angel One candle data to our HistoricalCandle format
   * Angel One returns: [timestamp, open, high, low, close, volume]
   */
  private parseCandles(symbol: string, data: any[]): HistoricalCandle[] {
    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((candle) => {
      const [timestamp, open, high, low, close, volume] = candle;

      return {
        symbol,
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(volume),
        timestamp: new Date(timestamp),
      };
    });
  }

  /**
   * Generate TOTP for two-factor authentication
   */
  private generateTOTP(secret: string): string {
    try {
      const token = authenticator.generate(secret);
      logger.debug("TOTP generated successfully");
      return token;
    } catch (error) {
      logger.error({ err: error }, "Failed to generate TOTP");
      throw new Error("Failed to generate TOTP code");
    }
  }

  /**
   * Check if provider is authenticated
   */
  isReady(): boolean {
    return this.isAuthenticated;
  }

  /**
   * Disconnect and clear authentication
   */
  async disconnect(): Promise<void> {
    this.isAuthenticated = false;
    logger.info("Angel One provider disconnected");
  }
}

export default AngelOneHistoricalProvider;
