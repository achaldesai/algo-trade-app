import { describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "events";
import { MarketScannerService } from "./MarketScannerService";
import { HistoricalDataService } from "./HistoricalDataService";
import type { SettingsRepo } from "../db/repositories/SettingsRepo";

function stubSettingsRepo(): SettingsRepo {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getUniverse: () => undefined,
  }) as unknown as SettingsRepo;
}

describe("MarketScannerService", () => {
  it("should be able to initialize", () => {
    const historicalService = new HistoricalDataService();
    const service = new MarketScannerService(historicalService, stubSettingsRepo());
    assert.ok(service);
  });

  it("should filter and score symbols based on criteria", async () => {
    // This test would ideally mock the historical data to return a bullish setup
    // For now, we just check if it runs without errors
    const historicalService = new HistoricalDataService();
    const service = new MarketScannerService(historicalService, stubSettingsRepo());

    // We expect 0 results with mock data because criteria are strict
    const picks = await service.scan();
    assert.ok(Array.isArray(picks));
  });
});
