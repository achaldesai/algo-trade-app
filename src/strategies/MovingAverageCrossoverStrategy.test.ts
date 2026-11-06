import assert from "node:assert/strict";
import { describe, it } from "node:test";
import MovingAverageCrossoverStrategy from "./MovingAverageCrossoverStrategy";
import { barsFrom, dailyContext } from "./testBars";

const strategy = new MovingAverageCrossoverStrategy();
const params = { fastPeriod: 3, slowPeriod: 5, maType: "sma", orderSize: 7 };

/** Evaluate on every prefix of the series; return the indices that signalled. */
async function signalDays(closes: number[], held: number) {
  const days: { index: number; side: string; quantity: number }[] = [];
  for (let i = 1; i <= closes.length; i++) {
    const ctx = dailyContext({ TCS: barsFrom("TCS", closes.slice(0, i)) }, params, { TCS: held });
    for (const signal of await strategy.generateSignals(ctx)) {
      const [order] = signal.requestedOrders;
      days.push({ index: i - 1, side: order.side, quantity: order.quantity });
    }
  }
  return days;
}

describe("MovingAverageCrossoverStrategy", () => {
  it("is a stateless daily strategy", () => {
    assert.equal(strategy.timeframe, "1day");
    assert.equal(strategy.getWarmupBars(params), 6);
    assert.equal(strategy.getWarmupBars({ ...params, maType: "ema" }), 15);
  });

  it("buys exactly once, on the day SMA3 crosses above SMA5", async () => {
    // Day 6: SMA3 = 10.33 > SMA5 = 10.2, the day before both were 10.
    const closes = [10, 10, 10, 10, 10, 10, 11, 12, 13];
    assert.deepEqual(await signalDays(closes, 0), [{ index: 6, side: "BUY", quantity: 7 }]);
  });

  it("sells the whole position on the cross back below", async () => {
    const closes = [10, 10, 10, 10, 10, 10, 9, 8];
    assert.deepEqual(await signalDays(closes, 12), [{ index: 6, side: "SELL", quantity: 12 }]);
  });

  it("does not buy again while holding, or sell when flat", async () => {
    assert.deepEqual(await signalDays([10, 10, 10, 10, 10, 10, 11, 12], 5), []);
    assert.deepEqual(await signalDays([10, 10, 10, 10, 10, 10, 9, 8], 0), []);
  });

  it("stays silent until warmed up and without bars", async () => {
    assert.deepEqual(await signalDays([10, 11, 12, 13], 0), []);
    const ctx = dailyContext({}, params);
    delete ctx.bars;
    assert.deepEqual(await strategy.generateSignals(ctx), []);
  });

  it("uses the bar date for the order tag, not the wall clock", async () => {
    const ctx = dailyContext({ TCS: barsFrom("TCS", [10, 10, 10, 10, 10, 10, 11]) }, params);
    const [signal] = await strategy.generateSignals(ctx);
    assert.equal(signal.requestedOrders[0].tag, `MAX-${ctx.market.asOf.getTime()}`);
    assert.equal(signal.requestedOrders[0].price, 11);
  });

  it("rejects fastPeriod >= slowPeriod", async () => {
    const ctx = dailyContext({ TCS: barsFrom("TCS", [10, 11]) }, { ...params, fastPeriod: 5 });
    await assert.rejects(strategy.generateSignals(ctx), /fastPeriod/);
  });
});
