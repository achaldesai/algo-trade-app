import type { HistoricalCandle, HistoricalDataRequest } from "../types";
import logger from "../utils/logger";

export interface HistoricalDataCache {
  get(key: string): HistoricalCandle[] | undefined;
  set(key: string, data: HistoricalCandle[], ttlMs: number): void;
  clear(): void;
}

class InMemoryCache implements HistoricalDataCache {
  private cache = new Map<string, { data: HistoricalCandle[]; expires: number; lastAccessed: number }>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = 100) {
    this.maxEntries = maxEntries;
  }

  get(key: string): HistoricalCandle[] | undefined {
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expires) {
      this.cache.delete(key);
      return undefined;
    }

    // Update last accessed time for LRU
    entry.lastAccessed = Date.now();
    return entry.data;
  }

  set(key: string, data: HistoricalCandle[], ttlMs: number): void {
    // Evict LRU entry if cache is full
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      this.evictLRU();
    }

    this.cache.set(key, {
      data,
      expires: Date.now() + ttlMs,
      lastAccessed: Date.now(),
    });
  }

  /**
   * Evict the least recently used entry from cache
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      // Also evict expired entries opportunistically
      if (Date.now() > entry.expires) {
        this.cache.delete(key);
        continue;
      }

      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      logger.debug({ evictedKey: oldestKey }, "Evicted LRU cache entry");
      this.cache.delete(oldestKey);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

export interface HistoricalDataProvider {
  fetchHistoricalData(request: HistoricalDataRequest): Promise<HistoricalCandle[]>;
}

class ZerodhaHistoricalProvider implements HistoricalDataProvider {
  async fetchHistoricalData(request: HistoricalDataRequest): Promise<HistoricalCandle[]> {
    logger.info({ symbol: request.symbol, interval: request.interval }, "Fetching historical data from Zerodha");

    // TODO: Implement actual Zerodha historical data API call
    // This would use KiteConnect.getHistoricalData()

    // Mock implementation for now
    const mockData: HistoricalCandle[] = [];
    const startDate = new Date(request.fromDate);
    const endDate = new Date(request.toDate);

    const currentDate = new Date(startDate);
    let price = 100 + Math.random() * 50;

    while (currentDate <= endDate) {
      const dailyChange = (Math.random() - 0.5) * 4; // ±2% daily change
      const open = price;
      const close = price + dailyChange;
      const high = Math.max(open, close) + Math.random() * 2;
      const low = Math.min(open, close) - Math.random() * 2;
      const volume = 10000 + Math.random() * 50000;

      mockData.push({
        symbol: request.symbol,
        open: Number(open.toFixed(2)),
        high: Number(high.toFixed(2)),
        low: Number(low.toFixed(2)),
        close: Number(close.toFixed(2)),
        volume: Math.round(volume),
        timestamp: new Date(currentDate),
      });

      price = close;

      // Increment date based on interval
      if (request.interval === "1day") {
        currentDate.setDate(currentDate.getDate() + 1);
      } else if (request.interval === "1week") {
        currentDate.setDate(currentDate.getDate() + 7);
      } else if (request.interval === "1month") {
        currentDate.setMonth(currentDate.getMonth() + 1);
      }
    }

    return mockData;
  }
}

export class HistoricalDataService {
  private readonly cache: HistoricalDataCache;
  private readonly provider: HistoricalDataProvider;
  private readonly defaultCacheTtl: number;

  constructor(
    cache: HistoricalDataCache = new InMemoryCache(),
    provider: HistoricalDataProvider = new ZerodhaHistoricalProvider(),
    defaultCacheTtlHours = 4
  ) {
    this.cache = cache;
    this.provider = provider;
    this.defaultCacheTtl = defaultCacheTtlHours * 60 * 60 * 1000;
  }

  async getHistoricalData(request: HistoricalDataRequest): Promise<HistoricalCandle[]> {
    const cacheKey = this.buildCacheKey(request);

    // Try cache first
    const cached = this.cache.get(cacheKey);
    if (cached) {
      logger.debug({ symbol: request.symbol, cacheKey }, "Historical data cache hit");
      return cached;
    }

    // Fetch from provider
    logger.info({ symbol: request.symbol, interval: request.interval }, "Fetching historical data");
    const data = await this.provider.fetchHistoricalData(request);

    // Cache the result
    this.cache.set(cacheKey, data, this.defaultCacheTtl);

    return data;
  }

  async getRecentData(symbol: string, days: number = 252): Promise<HistoricalCandle[]> {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    return this.getHistoricalData({
      symbol,
      interval: "1day",
      fromDate,
      toDate,
    });
  }

  async getWeeklyData(symbol: string, weeks: number = 52): Promise<HistoricalCandle[]> {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - (weeks * 7));

    return this.getHistoricalData({
      symbol,
      interval: "1week",
      fromDate,
      toDate,
    });
  }

  clearCache(): void {
    this.cache.clear();
    logger.info("Historical data cache cleared");
  }

  private buildCacheKey(request: HistoricalDataRequest): string {
    const fromStr = request.fromDate.toISOString().split('T')[0];
    const toStr = request.toDate.toISOString().split('T')[0];
    return `${request.symbol}_${request.interval}_${fromStr}_${toStr}`;
  }
}

export default HistoricalDataService;