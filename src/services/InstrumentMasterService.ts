import { promises as fs } from "node:fs";
import path from "node:path";
import logger from "../utils/logger";

export interface Instrument {
  token: string;
  symbol: string;
  name: string;
  expiry: string;
  strike: string;
  lotsize: string;
  instrumenttype: string;
  exch_seg: string;
  tick_size: string;
}

/**
 * Service for managing Angel One instrument master data
 * Provides symbol-to-token mapping for API calls
 */
export class InstrumentMasterService {
  private instruments: Map<string, Instrument> = new Map();
  private symbolToTokenMap: Map<string, string> = new Map();
  private isLoaded = false;
  private loadingPromise: Promise<void> | null = null;

  private readonly INSTRUMENT_FILE = path.join(
    process.cwd(),
    "data",
    "angelone-instruments.json"
  );

  private readonly INSTRUMENT_URL =
    "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

  /**
   * Download instrument master file from Angel One
   */
  async downloadInstrumentMaster(): Promise<void> {
    try {
      logger.info("Downloading Angel One instrument master...");

      // Ensure data directory exists
      await fs.mkdir(path.dirname(this.INSTRUMENT_FILE), { recursive: true });

      // Download file using fetch (Node 18+)
      const response = await fetch(this.INSTRUMENT_URL);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.text();

      // Save to file
      await fs.writeFile(this.INSTRUMENT_FILE, data, "utf-8");

      logger.info(
        { path: this.INSTRUMENT_FILE },
        "Instrument master downloaded successfully"
      );
    } catch (error) {
      logger.error({ err: error }, "Failed to download instrument master");
      throw error;
    }
  }

  /**
   * Load instrument master from file
   */
  async loadInstrumentMaster(): Promise<void> {
    if (this.isLoaded) {
      return;
    }

    // If loading is in progress, wait for it to complete (prevents race condition)
    if (this.loadingPromise) {
      await this.loadingPromise;
      return;
    }

    this.loadingPromise = this.doLoad();
    try {
      await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  /**
   * Internal method that performs the actual loading
   */
  private async doLoad(): Promise<void> {
    try {
      try {
        await fs.access(this.INSTRUMENT_FILE);
      } catch {
        // File doesn't exist, download it
        await this.downloadInstrumentMaster();
      }

      logger.info("Loading Angel One instrument master...");

      const data = await fs.readFile(this.INSTRUMENT_FILE, "utf-8");
      const instruments = JSON.parse(data) as Instrument[];

      for (const instrument of instruments) {
        const key = `${instrument.exch_seg}:${instrument.symbol}`;
        this.instruments.set(key, instrument);
        this.symbolToTokenMap.set(key, instrument.token);

        // Also add without exchange prefix for convenience
        if (!this.symbolToTokenMap.has(instrument.symbol)) {
          this.symbolToTokenMap.set(instrument.symbol, instrument.token);
        }
      }

      this.isLoaded = true;

      logger.info(
        { count: instruments.length },
        "Instrument master loaded successfully"
      );
    } catch (error) {
      logger.error({ err: error }, "Failed to load instrument master");
      throw error;
    }
  }

  /**
   * Get instrument token for a symbol
   * @param symbol - Trading symbol (e.g., "RELIANCE-EQ", "RELIANCE")
   * @param exchange - Exchange segment (e.g., "NSE", "BSE") - optional
   * @returns Instrument token or null if not found
   */
  getToken(symbol: string, exchange?: string): string | null {
    if (!this.isLoaded) {
      logger.warn("Instrument master not loaded, call loadInstrumentMaster() first");
      return null;
    }

    // Try with exchange prefix first
    if (exchange) {
      const key = `${exchange}:${symbol}`;
      const token = this.symbolToTokenMap.get(key);
      if (token) {
        return token;
      }

      // Try with -EQ suffix for NSE equity
      if (exchange === "NSE" && !symbol.endsWith("-EQ")) {
        const eqKey = `${exchange}:${symbol}-EQ`;
        const eqToken = this.symbolToTokenMap.get(eqKey);
        if (eqToken) {
          return eqToken;
        }
      }
    }

    // Fallback to symbol-only lookup
    const token = this.symbolToTokenMap.get(symbol);
    if (token) {
      return token;
    }

    // Try with -EQ suffix
    if (!symbol.endsWith("-EQ")) {
      const eqToken = this.symbolToTokenMap.get(`${symbol}-EQ`);
      if (eqToken) {
        return eqToken;
      }
    }

    logger.warn({ symbol, exchange }, "Instrument token not found");
    return null;
  }

  /**
   * Get full instrument details
   * @param symbol - Trading symbol
   * @param exchange - Exchange segment - optional
   * @returns Instrument details or null if not found
   */
  getInstrument(symbol: string, exchange?: string): Instrument | null {
    if (!this.isLoaded) {
      logger.warn("Instrument master not loaded");
      return null;
    }

    const key = exchange ? `${exchange}:${symbol}` : symbol;
    return this.instruments.get(key) || null;
  }

  /**
   * Search instruments by symbol pattern
   * @param pattern - Search pattern (case-insensitive)
   * @param limit - Maximum number of results (default: 10)
   * @returns Array of matching instruments
   */
  searchInstruments(pattern: string, limit = 10): Instrument[] {
    if (!this.isLoaded) {
      logger.warn("Instrument master not loaded");
      return [];
    }

    const results: Instrument[] = [];
    const lowerPattern = pattern.toLowerCase();

    for (const instrument of this.instruments.values()) {
      if (
        instrument.symbol.toLowerCase().includes(lowerPattern) ||
        instrument.name.toLowerCase().includes(lowerPattern)
      ) {
        results.push(instrument);

        if (results.length >= limit) {
          break;
        }
      }
    }

    return results;
  }

  /**
   * Check if instrument master is loaded
   */
  isReady(): boolean {
    return this.isLoaded;
  }

  /**
   * Get total number of instruments loaded
   */
  getInstrumentCount(): number {
    return this.instruments.size;
  }

  /**
   * Refresh instrument master (download and reload)
   */
  async refresh(): Promise<void> {
    this.isLoaded = false;
    this.instruments.clear();
    this.symbolToTokenMap.clear();

    await this.downloadInstrumentMaster();
    await this.loadInstrumentMaster();
  }
}

// Singleton instance
let instrumentMasterService: InstrumentMasterService | null = null;

/**
 * Get singleton instance of InstrumentMasterService
 */
export function getInstrumentMasterService(): InstrumentMasterService {
  if (!instrumentMasterService) {
    instrumentMasterService = new InstrumentMasterService();
  }
  return instrumentMasterService;
}

export default InstrumentMasterService;
