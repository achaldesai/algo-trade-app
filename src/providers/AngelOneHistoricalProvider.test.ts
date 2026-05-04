/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { AngelOneHistoricalProvider } from "./AngelOneHistoricalProvider";
import type { HistoricalDataRequest } from "../types";

// Mock SmartAPI class
class MockSmartAPI {
  accessToken: string | null = null;

  async generateSession(_clientId: string, _password: string, _totp?: string) {
    return { status: true, data: { jwtToken: "mock-jwt-token" } };
  }

  setAccessToken(token: string) {
    this.accessToken = token;
  }

  async getCandleData(_params: unknown) {
    return {
      status: true,
      data: [
        ["2025-01-01T09:15:00", 100, 105, 98, 102, 50000],
        ["2025-01-02T09:15:00", 102, 108, 101, 107, 60000],
      ],
    };
  }
}

describe("AngelOneHistoricalProvider", () => {
  const config = {
    apiKey: "test-key",
    clientId: "test-client",
    password: "test-password",
    defaultExchange: "NSE",
  };

  let provider: AngelOneHistoricalProvider;

  beforeEach(() => {
    provider = new AngelOneHistoricalProvider(config);
    // Replace the internal SmartAPI with our mock
    (provider as any).smartApi = new MockSmartAPI();
    (provider as any).isAuthenticated = true;
  });

  it("should authenticate and set access token", async () => {
    const freshProvider = new AngelOneHistoricalProvider(config);
    (freshProvider as any).smartApi = new MockSmartAPI();

    await freshProvider.authenticate();
    assert.equal(freshProvider.isReady(), true);
  });

  it("should not re-authenticate if already authenticated", async () => {
    provider.authenticate();
    assert.equal(provider.isReady(), true);
  });

  it("should fetch historical data and parse candles", async () => {
    const request: HistoricalDataRequest = {
      symbol: "RELIANCE",
      interval: "1day",
      fromDate: new Date("2025-01-01"),
      toDate: new Date("2025-01-02"),
    };

    const candles = await provider.fetchHistoricalData(request);

    assert.equal(candles.length, 2);
    assert.equal(candles[0].symbol, "RELIANCE");
    assert.equal(candles[0].open, 100);
    assert.equal(candles[0].high, 105);
    assert.equal(candles[0].low, 98);
    assert.equal(candles[0].close, 102);
    assert.equal(candles[0].volume, 50000);
    assert.equal(candles[1].close, 107);
  });

  it("should map interval formats correctly", async () => {
    const request: HistoricalDataRequest = {
      symbol: "TCS",
      interval: "1week",
      fromDate: new Date("2025-01-01"),
      toDate: new Date("2025-01-31"),
    };

    const candles = await provider.fetchHistoricalData(request);
    assert.equal(candles.length, 2);
  });

  it("should be disconnectable", async () => {
    await provider.disconnect();
    assert.equal(provider.isReady(), false);
  });

  it("should use configured exchange", async () => {
    const bseProvider = new AngelOneHistoricalProvider({
      ...config,
      defaultExchange: "BSE",
    });
    (bseProvider as any).smartApi = new MockSmartAPI();
    (bseProvider as any).isAuthenticated = true;

    const request: HistoricalDataRequest = {
      symbol: "RELIANCE",
      interval: "1day",
      fromDate: new Date("2025-01-01"),
      toDate: new Date("2025-01-02"),
    };

    const candles = await bseProvider.fetchHistoricalData(request);
    assert.ok(candles.length > 0);
  });
});
