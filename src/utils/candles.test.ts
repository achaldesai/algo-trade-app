import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { badBarsNote, cleanCandles } from "./candles";
import type { HistoricalCandle } from "../types";

const DAY = 86_400_000;
const D0 = Date.UTC(2019, 11, 16);
const series = (closes: number[]): HistoricalCandle[] =>
  closes.map((close, i) => ({
    symbol: "X",
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    timestamp: new Date(D0 + i * DAY),
  }));
const dates = (...idx: number[]) => idx.map((i) => new Date(D0 + i * DAY).toISOString().slice(0, 10));
const closes = (bars: HistoricalCandle[]) => bars.map((b) => b.close);

describe("cleanCandles", () => {
  it("removes a split glitch that snaps back (the NIFTYBEES 2019-12-19/20 shape)", () => {
    const { candles, removed } = cleanCandles(series([128.8, 129.1, 129.3, 13.0, 13.0, 129.9, 130.4]));
    assert.deepEqual(closes(candles), [128.8, 129.1, 129.3, 129.9, 130.4]);
    assert.deepEqual(removed, dates(3, 4));
  });

  it("removes upward spikes too", () => {
    const { candles, removed } = cleanCandles(series([100, 101, 1010, 102]));
    assert.deepEqual(closes(candles), [100, 101, 102]);
    assert.deepEqual(removed, dates(2));
  });

  it("keeps real crashes, slow recoveries and sustained re-ratings", () => {
    const crash = [100, 82, 78, 80, 85, 90, 97, 100]; // -18% day, like ICICIBANK 2020-03-23
    assert.deepEqual(cleanCandles(series(crash)).removed, []);
    const halving = [100, 45, 44, 46, 47, 48]; // -55% and it stays down
    assert.deepEqual(cleanCandles(series(halving)).removed, []);
    const rerating = [100, 160, 158, 161, 165];
    assert.deepEqual(cleanCandles(series(rerating)).removed, []);
  });

  it("only removes runs of at most 3 bars", () => {
    // Back within 15% on the 4th bar after the jump: too long to call a glitch.
    assert.deepEqual(cleanCandles(series([100, 10, 10, 10, 10, 100])).removed, []);
    assert.deepEqual(cleanCandles(series([100, 10, 10, 10, 100])).removed, dates(1, 2, 3));
  });

  it("can't confirm a spike in the last bars, so keeps it", () => {
    assert.deepEqual(cleanCandles(series([100, 101, 10])).removed, []);
  });

  it("sorts its output and leaves the input untouched", () => {
    const input = series([100, 10, 101]).reverse();
    const { candles } = cleanCandles(input);
    assert.deepEqual(closes(candles), [100, 101]);
    assert.equal(input.length, 3);
    assert.equal(input[0].close, 101);
  });

  it("formats a note only when something was removed", () => {
    assert.equal(badBarsNote("X", []), undefined);
    assert.match(badBarsNote("NIFTYBEES", ["2019-12-19", "2019-12-20"])!, /^NIFTYBEES: removed 2 bad bars \(2019-12-19, 2019-12-20\)/);
    assert.match(badBarsNote("X", ["2019-12-19"])!, /removed 1 bad bar \(/);
  });
});
