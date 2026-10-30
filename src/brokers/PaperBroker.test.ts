import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { PaperBroker } from "./PaperBroker";

describe("PaperBroker", () => {
  const livePrices = new Map<string, number>();
  let broker: PaperBroker;

  beforeEach(async () => {
    livePrices.clear();
    broker = new PaperBroker((symbol) => livePrices.get(symbol));
    await broker.connect();
  });

  it("refuses orders while disconnected", async () => {
    await broker.disconnect();
    await assert.rejects(
      broker.placeOrder({ symbol: "TCS", side: "BUY", quantity: 1, type: "MARKET" }),
      /not connected/,
    );
  });

  it("fills a MARKET BUY at the live tick plus 5 bps slippage", async () => {
    livePrices.set("TCS", 4000);
    const exec = await broker.placeOrder({ symbol: "TCS", side: "BUY", quantity: 10, type: "MARKET" });
    assert.equal(exec.status, "FILLED");
    assert.equal(exec.filledQuantity, 10);
    assert.equal(exec.averagePrice, 4002);
  });

  it("fills a MARKET SELL at the live tick minus 5 bps slippage", async () => {
    livePrices.set("TCS", 4000);
    const exec = await broker.placeOrder({ symbol: "TCS", side: "SELL", quantity: 10, type: "MARKET" });
    assert.equal(exec.averagePrice, 3998);
  });

  it("fills a LIMIT order at the limit price", async () => {
    livePrices.set("INFY", 1500);
    const exec = await broker.placeOrder({ symbol: "INFY", side: "BUY", quantity: 5, type: "LIMIT", price: 1490 });
    assert.equal(exec.averagePrice, 1490);
  });

  it("rejects a MARKET order with no price reference", async () => {
    await assert.rejects(
      broker.placeOrder({ symbol: "UNKNOWN", side: "BUY", quantity: 1, type: "MARKET" }),
      /no live tick or prior trade price/,
    );
  });

  it("falls back to the last paper trade price when no live tick exists", async () => {
    await broker.placeOrder({ symbol: "INFY", side: "BUY", quantity: 5, type: "LIMIT", price: 1000 });
    const exec = await broker.placeOrder({ symbol: "INFY", side: "SELL", quantity: 5, type: "MARKET" });
    assert.equal(exec.averagePrice, 999.5);
  });

  it("records fills as positions and reset() clears them", async () => {
    livePrices.set("TCS", 4000);
    await broker.placeOrder({ symbol: "TCS", side: "BUY", quantity: 10, type: "MARKET" });
    await broker.placeOrder({ symbol: "TCS", side: "SELL", quantity: 4, type: "MARKET" });

    const positions = await broker.getPositions();
    assert.equal(positions.length, 2);
    assert.deepEqual(positions.map((t) => [t.side, t.quantity]), [["BUY", 10], ["SELL", 4]]);
    assert.ok(positions.every((t) => !("brokerOrderId" in t)));

    broker.reset();
    assert.equal((await broker.getPositions()).length, 0);
  });

  it("cancelOrder accepts known orders and rejects unknown ones", async () => {
    livePrices.set("TCS", 4000);
    const exec = await broker.placeOrder({ symbol: "TCS", side: "BUY", quantity: 1, type: "MARKET" });
    await broker.cancelOrder(exec.id);
    await assert.rejects(broker.cancelOrder("nope"), /Unknown paper order/);
  });

  it("quotes from the live tick with side-dependent slippage", async () => {
    livePrices.set("TCS", 4000);
    assert.equal((await broker.getQuote("TCS", "BUY"))?.limitPrice, 4002);
    assert.equal((await broker.getQuote("TCS", "SELL"))?.limitPrice, 3998);
    assert.equal(await broker.getQuote("UNKNOWN", "BUY"), null);
  });
});
