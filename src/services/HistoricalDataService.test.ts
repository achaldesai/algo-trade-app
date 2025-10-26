import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HistoricalCandle, HistoricalDataRequest } from "../types";
import HistoricalDataService, { type HistoricalDataCache, type HistoricalDataProvider } from "./HistoricalDataService";

class MockCache implements HistoricalDataCache {
  private cache = new Map<string, HistoricalCandle[]>();

  get(key: string): HistoricalCandle[] | undefined {
    return this.cache.get(key);
  }

  set(key: string, data: HistoricalCandle[], _ttlMs: number): void {
    this.cache.set(key, data);
  }

  clear(): void {
    this.cache.clear();
  }
}

class MockProvider implements HistoricalDataProvider {
  private callCount = 0;

  async fetchHistoricalData(request: HistoricalDataRequest): Promise<HistoricalCandle[]> {
    this.callCount++;

    const mockCandle: HistoricalCandle = {
      symbol: request.symbol,
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 50000,
      timestamp: request.fromDate,
    };

    return [mockCandle];
  }

  getCallCount(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
  }
}

describe("HistoricalDataService", () => {
  it("fetches data from provider when cache is empty", async () => {
    const mockCache = new MockCache();
    const mockProvider = new MockProvider();
    const service = new HistoricalDataService(mockCache, mockProvider);

    const request: HistoricalDataRequest = {
      symbol: "AAPL",
      interval: "1day",
      fromDate: new Date("2023-01-01"),
      toDate: new Date("2023-01-31"),
    };

    const result = await service.getHistoricalData(request);

    assert.equal(result.length, 1);
    assert.equal(result[0].symbol, "AAPL");
    assert.equal(result[0].close, 102);
    assert.equal(mockProvider.getCallCount(), 1);
  });

  it("returns cached data on subsequent requests", async () => {
    const mockCache = new MockCache();
    const mockProvider = new MockProvider();
    const service = new HistoricalDataService(mockCache, mockProvider);

    const request: HistoricalDataRequest = {
      symbol: "AAPL",
      interval: "1day",
      fromDate: new Date("2023-01-01"),
      toDate: new Date("2023-01-31"),
    };

    // First call - should hit provider
    const result1 = await service.getHistoricalData(request);
    assert.equal(mockProvider.getCallCount(), 1);

    // Second call - should use cache
    const result2 = await service.getHistoricalData(request);
    assert.equal(mockProvider.getCallCount(), 1); // No additional call
    assert.deepEqual(result1, result2);
  });

  it("clears cache successfully", async () => {
    const mockCache = new MockCache();
    const mockProvider = new MockProvider();
    const service = new HistoricalDataService(mockCache, mockProvider);

    const request: HistoricalDataRequest = {
      symbol: "AAPL",
      interval: "1day",
      fromDate: new Date("2023-01-01"),
      toDate: new Date("2023-01-31"),
    };

    // Populate cache
    await service.getHistoricalData(request);
    assert.equal(mockProvider.getCallCount(), 1);

    // Clear cache
    service.clearCache();

    // Next call should hit provider again
    await service.getHistoricalData(request);
    assert.equal(mockProvider.getCallCount(), 2);
  });

  it("generates recent data request correctly", async () => {
    const mockCache = new MockCache();
    const mockProvider = new MockProvider();
    const service = new HistoricalDataService(mockCache, mockProvider);

    const result = await service.getRecentData("MSFT", 10);

    assert.equal(result.length, 1);
    assert.equal(result[0].symbol, "MSFT");
    assert.equal(mockProvider.getCallCount(), 1);
  });

  it("generates weekly data request correctly", async () => {
    const mockCache = new MockCache();
    const mockProvider = new MockProvider();
    const service = new HistoricalDataService(mockCache, mockProvider);

    const result = await service.getWeeklyData("GOOGL", 4);

    assert.equal(result.length, 1);
    assert.equal(result[0].symbol, "GOOGL");
    assert.equal(mockProvider.getCallCount(), 1);
  });
});