import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrokerOrderRequest } from "../types";
import AngelOneBroker from "./AngelOneBroker";

const baseOrder: BrokerOrderRequest = {
  symbol: "RELIANCE",
  side: "BUY",
  quantity: 1,
  type: "MARKET",
};

describe("AngelOneBroker placeOrder", () => {
  it("rejects orders when the session is not active (no paper fallback)", async () => {
    const broker = new AngelOneBroker({
      apiKey: "",
      clientId: "",
      password: "",
      defaultExchange: "NSE",
      productType: "DELIVERY",
    });

    await assert.rejects(
      () => broker.placeOrder(baseOrder),
      /Angel One session not active/,
    );
  });
});
