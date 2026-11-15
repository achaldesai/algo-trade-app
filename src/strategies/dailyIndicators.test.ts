import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buyOrderFlags, buySizer } from "./dailyIndicators";

const percent = (positionPct: number) => ({ sizing: "percent", positionPct });

describe("buySizer", () => {
  it("buys a fixed share count in shares mode, with or without an account", () => {
    assert.equal(buySizer({ sizing: "shares", orderSize: 7 })(1340), 7);
    assert.equal(buySizer({ orderSize: 7 }, { cash: 0, equity: 0 })(1340), 7, "shares is the default");
  });

  it("sizes from equity in percent mode, rounding down to whole shares", () => {
    const account = { cash: 5000, equity: 5000 };
    assert.equal(buySizer(percent(33), account)(1340), 1); // ₹1,650 budget
    assert.equal(buySizer(percent(33), account)(1584), 1);
    assert.equal(buySizer(percent(20), account)(1340), 0, "₹1,000 budget is below one share");
    assert.equal(buySizer(percent(100), account)(1000), 4, "0.5% of cash is kept back for costs and slippage");
    assert.equal(buySizer(percent(100), { cash: 10_000, equity: 10_000 })(1000), 9);
    assert.equal(buySizer(percent(100), account)(990), 5, "₹4,975 still covers 5 x 990");
  });

  it("caps at the cash available, and spends it down across buys in one evaluation", () => {
    // Equity 10,000 but only 3,000 in cash: a 50% budget is capped at the
    // ₹2,985 left after the 0.5% buffer.
    const size = buySizer(percent(50), { cash: 3000, equity: 10_000 });
    assert.equal(size(995), 3);
    assert.equal(size(995), 0, "the first buy used the cash");

    const shared = buySizer(percent(40), { cash: 5000, equity: 5000 });
    assert.equal(shared(1000), 2); // ₹2,000 budget
    assert.equal(shared(1000), 2);
    assert.equal(shared(900), 1, "only ₹975 left");
  });

  it("marks only percent-sized buys as resizable", () => {
    assert.deepEqual(buyOrderFlags({ sizing: "percent" }), { sizeToCash: true });
    assert.deepEqual(buyOrderFlags({ sizing: "shares" }), {});
    assert.deepEqual(buyOrderFlags({}), {});
  });

  it("never buys in percent mode without an account, or at a non-positive price", () => {
    assert.equal(buySizer(percent(25))(100), 0);
    assert.equal(buySizer(percent(25), { cash: 5000, equity: 5000 })(0), 0);
  });
});
