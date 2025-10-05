import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { BrokerOrderRequest } from "../types";
import ZerodhaBroker, { type ZerodhaBrokerConfig } from "./ZerodhaBroker";
import type { Connect, Trade as KiteTrade } from "kiteconnect/types/connect";

const baseConfig: ZerodhaBrokerConfig = {
  apiKey: "",
  defaultExchange: "NSE",
  product: "CNC",
};

const baseOrder: BrokerOrderRequest = {
  symbol: "MSFT",
  side: "BUY",
  quantity: 5,
  type: "MARKET",
};

afterEach(() => {
  mock.restoreAll();
});

describe("ZerodhaBroker fallback behaviour", () => {
  it("falls back to the paper broker when no API key is provided", async () => {
    const broker = new ZerodhaBroker(baseConfig);

    await broker.connect();

    const execution = await broker.placeOrder(baseOrder);
    assert.equal(execution.filledQuantity, baseOrder.quantity);

    const positions = await broker.getPositions();
    assert(positions.some((trade) => trade.symbol === baseOrder.symbol));
  });

  it("uses the fallback broker when client creation fails", async () => {
    const broker = new ZerodhaBroker(
      { ...baseConfig, apiKey: "dummy" },
      {
        createClient: () => {
          throw new Error("boom");
        },
        now: () => new Date("2024-01-01T00:00:00.000Z"),
      },
    );

    await broker.connect();
    const execution = await broker.placeOrder(baseOrder);

    assert.equal(execution.filledQuantity, baseOrder.quantity);
  });
});

describe("ZerodhaBroker kiteconnect integration", () => {
  const now = new Date("2024-01-01T00:00:00.000Z");

const trade: KiteTrade = {
  trade_id: "trade-1",
  order_id: "order-1",
  exchange_order_id: "ex-1",
  tradingsymbol: "AAPL",
  exchange: "NSE",
  instrument_token: 123,
  transaction_type: "BUY",
  product: "CNC",
  average_price: 101.25,
  filled: 5,
  quantity: 5,
  fill_timestamp: now,
  order_timestamp: now,
  exchange_timestamp: now,
};

type QuoteStubEntry = {
  instrument_token: number;
  last_price: number;
  volume: number;
  average_price: number;
  buy_quantity: number;
  sell_quantity: number;
  last_quantity: number;
  ohlc: { open: number; high: number; low: number; close: number };
  net_change: number;
  lower_circuit_limit: number;
  upper_circuit_limit: number;
  oi: number;
  oi_day_high: number;
  oi_day_low: number;
  depth: {
    buy: Array<{ price: number; orders: number; quantity: number }>;
    sell: Array<{ price: number; orders: number; quantity: number }>;
  };
};

const buildKiteStub = () => {
    const stats = {
      setAccessToken: 0,
      placeOrder: 0,
      getOrderTrades: 0,
      getTrades: 0,
      cancelOrder: 0,
      getQuote: 0,
    };

    const stub = {
      VARIETY_REGULAR: "regular",
      ORDER_TYPE_MARKET: "MARKET",
      ORDER_TYPE_LIMIT: "LIMIT",
      VALIDITY_DAY: "DAY",
      setAccessToken: () => {
        stats.setAccessToken += 1;
      },
      placeOrder: async () => {
        stats.placeOrder += 1;
        return { order_id: "order-1" };
      },
      getOrderTrades: async () => {
        stats.getOrderTrades += 1;
        return [trade];
      },
      getTrades: async () => {
        stats.getTrades += 1;
        return [trade];
      },
      cancelOrder: async () => {
        stats.cancelOrder += 1;
      },
      getQuote: async () => {
        stats.getQuote += 1;
        return {
          "NSE:AAPL": {
            instrument_token: 123,
            last_price: 202,
            volume: 100,
            average_price: 201,
            buy_quantity: 200,
            sell_quantity: 150,
            last_quantity: 10,
            ohlc: { open: 200, high: 205, low: 195, close: 198 },
            net_change: 2,
            lower_circuit_limit: 180,
            upper_circuit_limit: 220,
            oi: 0,
            oi_day_high: 0,
            oi_day_low: 0,
            depth: {
              buy: [{ price: 201, orders: 4, quantity: 12 }],
              sell: [{ price: 203, orders: 3, quantity: 8 }],
            },
          },
        } satisfies Record<string, QuoteStubEntry>;
      },
    } as unknown as Connect;

    return { stub, stats };
  };

  it("places orders and maps trades using kiteconnect", async () => {
    const kite = buildKiteStub();

    const broker = new ZerodhaBroker(
      {
        apiKey: "key",
        accessToken: "access",
        defaultExchange: "NSE",
        product: "CNC",
      },
      {
        createClient: () => kite.stub,
        now: () => now,
      },
    );

    await broker.connect();
    assert.equal(kite.stats.setAccessToken, 1);

    const execution = await broker.placeOrder({ symbol: "AAPL", side: "BUY", quantity: 5, type: "MARKET" });
    assert.equal(kite.stats.placeOrder, 1);
    assert.equal(kite.stats.getOrderTrades, 1);
    assert.equal(execution.id, "order-1");
    assert.equal(execution.status, "FILLED");
    assert.equal(execution.filledQuantity, 5);
    assert.equal(Number(execution.averagePrice.toFixed(2)), 101.25);

    const positions = await broker.getPositions();
    assert.equal(kite.stats.getTrades, 1);
    assert.equal(positions[0]?.symbol, "AAPL");

    const quote = await broker.getQuote("AAPL", "BUY");
    assert.equal(kite.stats.getQuote, 1);
    assert(quote);
    assert.equal(quote?.symbol, "AAPL");

    await broker.cancelOrder("order-1");
    assert.equal(kite.stats.cancelOrder, 1);
  });
});
