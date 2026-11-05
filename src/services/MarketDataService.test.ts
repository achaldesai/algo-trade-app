import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MarketDataService } from "./MarketDataService";
import type { MarketTick } from "../types";

describe("MarketDataService", () => {
  it("normalises symbols to upper case and rounds price/volume", () => {
    const md = new MarketDataService();
    const tick = md.updateTick({ symbol: "reliance", price: 2500.123456, volume: 10.567, averagePrice: 2499.99999 });
    assert.equal(tick.symbol, "RELIANCE");
    assert.equal(tick.price, 2500.1235);
    assert.equal(tick.volume, 10.57);
    assert.equal(tick.averagePrice, 2500);
    assert.equal(md.getTick("Reliance")?.price, 2500.1235);
  });

  it("accepts ISO string timestamps", () => {
    const md = new MarketDataService();
    const tick = md.updateTick({ symbol: "TCS", price: 1, volume: 1, timestamp: "2026-11-05T04:00:00.000Z" });
    assert.ok(tick.timestamp instanceof Date);
    assert.equal(tick.timestamp.toISOString(), "2026-11-05T04:00:00.000Z");
  });

  it("emits a tick event per update", () => {
    const md = new MarketDataService();
    const seen: MarketTick[] = [];
    md.on("tick", (t: MarketTick) => seen.push(t));
    md.updateTick({ symbol: "TCS", price: 1, volume: 1 });
    md.updateTick({ symbol: "INFY", price: 2, volume: 1 });
    assert.deepEqual(seen.map((t) => t.symbol), ["TCS", "INFY"]);
  });

  it("caps tick history at the configured size and returns the most recent ticks", () => {
    const md = new MarketDataService(3);
    for (let i = 1; i <= 5; i++) md.updateTick({ symbol: "TCS", price: i, volume: 1 });
    assert.deepEqual(md.getTickHistory("TCS").map((t) => t.price), [3, 4, 5]);
    assert.deepEqual(md.getTickHistory("tcs", 2).map((t) => t.price), [4, 5]);
    assert.deepEqual(md.getTickHistory("UNKNOWN"), []);
  });

  it("returns a sorted snapshot, optionally filtered, skipping unknown symbols", () => {
    const md = new MarketDataService();
    md.updateTick({ symbol: "TCS", price: 1, volume: 1 });
    md.updateTick({ symbol: "INFY", price: 2, volume: 1 });
    md.updateTick({ symbol: "HDFC", price: 3, volume: 1 });
    assert.deepEqual(md.getSnapshot().ticks.map((t) => t.symbol), ["HDFC", "INFY", "TCS"]);
    assert.deepEqual(md.getSnapshot(["tcs", "nope"]).ticks.map((t) => t.symbol), ["TCS"]);
    assert.deepEqual(md.getTrackedSymbols().sort(), ["HDFC", "INFY", "TCS"]);
  });

  it("keeps indicators per symbol and reports readiness", () => {
    const md = new MarketDataService();
    assert.equal(md.getIndicators("TCS"), undefined);
    assert.equal(md.indicatorsReady("TCS"), false);

    for (let i = 0; i < 60; i++) md.updateTick({ symbol: "TCS", price: 100 + i, volume: 1 });
    md.updateTick({ symbol: "INFY", price: 50, volume: 1 });

    assert.equal(md.indicatorsReady("TCS"), true);
    assert.equal(md.indicatorsReady("INFY"), false);
    const tcs = md.getIndicators("TCS")!;
    // Default SMA period is 20: last 20 prices are 140..159 -> 149.5
    assert.equal(tcs.sma, 149.5);
  });
});
