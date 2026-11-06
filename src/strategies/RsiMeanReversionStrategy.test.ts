import assert from "node:assert/strict";
import { describe, it } from "node:test";
import RsiMeanReversionStrategy from "./RsiMeanReversionStrategy";
import { barsFrom, dailyContext } from "./testBars";

const strategy = new RsiMeanReversionStrategy();
const params = { period: 5, oversold: 30, exitLevel: 55, orderSize: 4 };

const run = (closes: number[], held: number, p = params) =>
  strategy.generateSignals(dailyContext({ INFY: barsFrom("INFY", closes) }, p, { INFY: held }));

// Steady decline: every change is a loss, so RSI = 0.
const falling = [20, 19, 18, 17, 16, 15, 14];
// Steady rise: no losses, so RSI = 100.
const rising = [14, 15, 16, 17, 18, 19, 20];

describe("RsiMeanReversionStrategy", () => {
  it("is a daily strategy with a warmup of 5x the period", () => {
    assert.equal(strategy.timeframe, "1day");
    assert.equal(strategy.getWarmupBars(params), 25);
  });

  it("buys when RSI is oversold and flat", async () => {
    const [signal] = await run(falling, 0);
    assert.deepEqual(
      { side: signal.requestedOrders[0].side, quantity: signal.requestedOrders[0].quantity, price: signal.requestedOrders[0].price },
      { side: "BUY", quantity: 4, price: 14 },
    );
  });

  it("sells the whole position when RSI recovers above the exit level", async () => {
    const [signal] = await run(rising, 9);
    assert.equal(signal.requestedOrders[0].side, "SELL");
    assert.equal(signal.requestedOrders[0].quantity, 9);
  });

  it("holds when RSI is between the levels, already long, or flat on a rally", async () => {
    assert.deepEqual(await run(falling, 3), [], "already long");
    assert.deepEqual(await run(rising, 0), [], "nothing to sell");
    // Alternating changes keep RSI near 50.
    assert.deepEqual(await run([10, 11, 10, 11, 10, 11, 10], 0), []);
    assert.deepEqual(await run([10, 11, 10, 11, 10, 11, 10], 3), []);
  });

  it("needs period + 1 bars before signalling", async () => {
    assert.deepEqual(await run(falling.slice(0, 5), 0), []);
    assert.equal((await run(falling.slice(0, 6), 0)).length, 1);
  });

  it("rejects oversold >= exitLevel", async () => {
    await assert.rejects(run(falling, 0, { ...params, oversold: 60 }), /oversold/);
  });
});
