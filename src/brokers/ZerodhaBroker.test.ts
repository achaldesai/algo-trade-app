import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { BrokerOrderRequest } from "../types";
import ZerodhaBroker, { type ZerodhaBrokerConfig } from "./ZerodhaBroker";
import fixtures from "../data/fixtures.json";
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

const now = new Date("2024-01-01T00:00:00.000Z");

const trade: KiteTrade = {
  ...fixtures.kiteTrade,
  fill_timestamp: now,
  order_timestamp: now,
  exchange_timestamp: now,
} as unknown as KiteTrade;

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
    getOrderHistory: 0,
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
    getOrderHistory: async () => {
      stats.getOrderHistory += 1;
      return [];
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
      return fixtures.kiteQuote as unknown as Record<string, QuoteStubEntry>;
    },
  } as unknown as Connect;

  return { stub, stats };
};

afterEach(() => {
  mock.restoreAll();
});

describe("ZerodhaBroker fallback behaviour", () => {
  it("rejects orders when no API key is provided (no paper fallback)", async () => {
    const broker = new ZerodhaBroker(baseConfig);

    await broker.connect();

    await assert.rejects(
      () => broker.placeOrder(baseOrder),
      /Zerodha session not active/,
    );
  });

  it("rejects orders when client creation fails (no paper fallback)", async () => {
    const broker = new ZerodhaBroker(
      { ...baseConfig, apiKey: "dummy" },
      {
        dependencies: {
          createClient: () => {
            throw new Error("boom");
          },
          now: () => now,
        },
      },
    );

    await broker.connect();

    await assert.rejects(
      () => broker.placeOrder(baseOrder),
      /Zerodha session not active/,
    );
  });

  it("rejects when the live kite client rejects placeOrder (no paper fill)", async () => {
    const { stub } = buildKiteStub();
    const rejectingStub = {
      ...stub,
      placeOrder: async () => {
        throw new Error("kite placeOrder failed");
      },
    } as unknown as Connect;

    const broker = new ZerodhaBroker(
      {
        apiKey: "key",
        accessToken: "access",
        defaultExchange: "NSE",
        product: "CNC",
      },
      {
        dependencies: {
          createClient: () => rejectingStub,
          now: () => now,
        },
      },
    );

    await broker.connect();

    await assert.rejects(
      () => broker.placeOrder(baseOrder),
      /kite placeOrder failed/,
    );
  });
});

describe("ZerodhaBroker kiteconnect integration", () => {
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
        dependencies: {
          createClient: () => kite.stub,
          now: () => now,
        },
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

describe("ZerodhaBroker MARKET order fill resolution", () => {
  it("polls getOrderTrades until the fill settles", async () => {
    const { stub } = buildKiteStub();
    let tradesCalls = 0;
    const pollingStub = {
      ...stub,
      getOrderTrades: async () => {
        tradesCalls += 1;
        return tradesCalls === 1 ? [] : [trade];
      },
    } as unknown as Connect;

    const broker = new ZerodhaBroker(
      { apiKey: "key", accessToken: "access", defaultExchange: "NSE", product: "CNC" },
      { dependencies: { createClient: () => pollingStub, now: () => now } },
    );

    await broker.connect();

    const execution = await broker.placeOrder({ symbol: "AAPL", side: "BUY", quantity: 5, type: "MARKET" });

    assert.equal(tradesCalls, 2);
    assert.equal(execution.id, "order-1");
    assert.equal(execution.status, "FILLED");
    assert.equal(execution.filledQuantity, 5);
    assert.equal(Number(execution.averagePrice.toFixed(2)), 101.25);
  });

  it("falls back to order history when trades never settle", async () => {
    const { stub } = buildKiteStub();
    const fallbackStub = {
      ...stub,
      getOrderTrades: async () => [],
      getOrderHistory: async () => [
        {
          order_id: "order-1",
          status: "COMPLETE",
          quantity: 5,
          filled_quantity: 5,
          average_price: 101.5,
          order_timestamp: now,
          exchange_timestamp: null,
          exchange_update_timestamp: null,
        },
      ],
    } as unknown as Connect;

    const broker = new ZerodhaBroker(
      { apiKey: "key", accessToken: "access", defaultExchange: "NSE", product: "CNC" },
      { dependencies: { createClient: () => fallbackStub, now: () => now } },
    );

    await broker.connect();

    const execution = await broker.placeOrder({ symbol: "AAPL", side: "BUY", quantity: 5, type: "MARKET" });

    assert.equal(execution.id, "order-1");
    assert.equal(execution.status, "FILLED");
    assert.equal(execution.filledQuantity, 5);
    assert.equal(execution.averagePrice, 101.5);
    assert.equal(execution.executedAt.getTime(), now.getTime());
  });

  it("returns PARTIALLY_FILLED with zero quantity when no fill info is available", async () => {
    const { stub } = buildKiteStub();
    const noFillStub = {
      ...stub,
      getOrderTrades: async () => [],
      getOrderHistory: async () => [],
    } as unknown as Connect;

    const broker = new ZerodhaBroker(
      { apiKey: "key", accessToken: "access", defaultExchange: "NSE", product: "CNC" },
      { dependencies: { createClient: () => noFillStub, now: () => now } },
    );

    await broker.connect();

    const execution = await broker.placeOrder({ symbol: "AAPL", side: "BUY", quantity: 5, type: "MARKET" });

    assert.equal(execution.id, "order-1");
    assert.equal(execution.status, "PARTIALLY_FILLED");
    assert.equal(execution.filledQuantity, 0);
    assert.equal(execution.averagePrice, 0);
  });
});
