import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { WebSocketV2 } from "smartapi-javascript";
import AngelOneTickerService from "./AngelOneTickerService";
import type { MarketDataService } from "./MarketDataService";
import type { TokenRepo } from "../db/repositories/TokenRepo";

type WsParams = ConstructorParameters<typeof WebSocketV2>[0];
type WsInstance = InstanceType<typeof WebSocketV2>;

interface RecordedTick {
  symbol: string;
  price: number;
  volume: number;
  averagePrice?: number;
}

/**
 * Minimal fake of the smartapi-javascript WebSocketV2. Mirrors the SDK's
 * shared module-level `triggers` array by keeping tick handlers in a static
 * registry shared across all instances, so a tick "emitted" from any instance
 * reaches every registered handler.
 */
class FakeWebSocketV2 {
  static instances: FakeWebSocketV2[] = [];
  static tickHandlers: Array<(data: unknown) => void> = [];

  readonly params: WsParams;
  connectResult: Promise<void> = Promise.resolve();
  customErrorCalled = false;
  connectCalls = 0;
  closeCalls = 0;
  reconnectionCalls: Array<{ type: string; delay: number; multiplier?: number }> = [];
  fetchDataCalls: Array<Record<string, unknown>> = [];

  constructor(params: WsParams) {
    this.params = params;
    FakeWebSocketV2.instances.push(this);
  }

  on(event: string, cb: (data: unknown) => void): void {
    if (event === "tick") {
      FakeWebSocketV2.tickHandlers.push(cb);
    }
  }

  customError(): void {
    this.customErrorCalled = true;
  }

  reconnection(type: string, delay: number, multiplier?: number): void {
    this.reconnectionCalls.push({ type, delay, multiplier });
  }

  connect(): Promise<void> {
    this.connectCalls += 1;
    return this.connectResult;
  }

  fetchData(req: Record<string, unknown>): void {
    this.fetchDataCalls.push(req);
  }

  close(): void {
    this.closeCalls += 1;
  }

  static emitTick(data: unknown): void {
    for (const cb of FakeWebSocketV2.tickHandlers) cb(data);
  }

  static reset(): void {
    FakeWebSocketV2.instances = [];
    FakeWebSocketV2.tickHandlers = [];
  }
}

function makeTokenRepo(): TokenRepo {
  return {
    getAngelOneToken: () => ({
      jwtToken: "jwt-token",
      refreshToken: "refresh-token",
      feedToken: "feed-token",
      clientId: "CLIENT123",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  } as unknown as TokenRepo;
}

function makeMarketData() {
  const calls: RecordedTick[] = [];
  return {
    calls,
    updateTick: (input: RecordedTick) => {
      calls.push(input);
    },
    getTick: () => undefined,
  };
}

function makeService(options: {
  createWebSocket?: (params: WsParams) => FakeWebSocketV2;
  connectTimeoutMs?: number;
} = {}) {
  const marketData = makeMarketData();
  const tokenRepo = makeTokenRepo();
  const innerFactory =
    options.createWebSocket ?? ((params: WsParams) => new FakeWebSocketV2(params));

  const service = new AngelOneTickerService(
    marketData as unknown as MarketDataService,
    tokenRepo,
    {
      createWebSocket: (params: WsParams) =>
        innerFactory(params) as unknown as WsInstance,
      connectTimeoutMs: options.connectTimeoutMs,
    },
  );

  return { service, marketData };
}

describe("AngelOneTickerService", () => {
  const originalApiKey = process.env.ANGEL_ONE_API_KEY;

  beforeEach(() => {
    process.env.ANGEL_ONE_API_KEY = "test-key";
    FakeWebSocketV2.reset();
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANGEL_ONE_API_KEY;
    } else {
      process.env.ANGEL_ONE_API_KEY = originalApiKey;
    }
  });

  it("registers the on('tick') handler exactly once across multiple session opens", async () => {
    const { service } = makeService();

    await (service as unknown as { openWebSocket(): Promise<void> }).openWebSocket();
    await (service as unknown as { closeWebSocket(): Promise<void> }).closeWebSocket();
    await (service as unknown as { openWebSocket(): Promise<void> }).openWebSocket();
    await (service as unknown as { closeWebSocket(): Promise<void> }).closeWebSocket();
    await (service as unknown as { openWebSocket(): Promise<void> }).openWebSocket();

    // 1 handler-owner instance (constructor) + 3 connection instances.
    assert.equal(FakeWebSocketV2.instances.length, 4);
    assert.equal(FakeWebSocketV2.tickHandlers.length, 1);

    await (service as unknown as { closeWebSocket(): Promise<void> }).closeWebSocket();
  });

  it("surfaces a rejected connect (bad token) and calls customError before connect", async () => {
    const order: string[] = [];
    const factory = (params: WsParams) => {
      const ws = new FakeWebSocketV2(params);
      // Only the per-connection instance (non-empty clientcode) rejects; the
      // handler-owner instance never connects.
      if (params.clientcode !== "") {
        ws.connectResult = Promise.reject(new Error("bad token"));
        const originalCustomError = ws.customError.bind(ws);
        const originalConnect = ws.connect.bind(ws);
        ws.customError = () => {
          order.push("customError");
          originalCustomError();
        };
        ws.connect = () => {
          order.push("connect");
          return originalConnect();
        };
      }
      return ws;
    };

    const { service } = makeService({ createWebSocket: factory });

    await assert.rejects(
      () => (service as unknown as { openWebSocket(): Promise<void> }).openWebSocket(),
      /bad token/,
    );

    const connection = FakeWebSocketV2.instances[1];
    assert.equal(connection.customErrorCalled, true);
    assert.deepEqual(order, ["customError", "connect"]);
  });

  it("times out (and closes) when connect() never settles", async () => {
    const factory = (params: WsParams) => {
      const ws = new FakeWebSocketV2(params);
      if (params.clientcode !== "") {
        ws.connectResult = new Promise<void>(() => {});
      }
      return ws;
    };

    const { service } = makeService({ createWebSocket: factory, connectTimeoutMs: 20 });

    await assert.rejects(
      () => (service as unknown as { openWebSocket(): Promise<void> }).openWebSocket(),
      /timed out/i,
    );

    const connection = FakeWebSocketV2.instances[1];
    assert.equal(connection.closeCalls, 1);
  });

  it("drops ticks with non-positive or non-finite LTP and processes valid ticks", async () => {
    const { service, marketData } = makeService();

    await (service as unknown as { openWebSocket(): Promise<void> }).openWebSocket();

    service.subscribe({ exchange: "NSE", symbolToken: "3045", symbol: "RELIANCE" });

    // Valid tick: LTP 12345 -> 123.45
    FakeWebSocketV2.emitTick({
      exchange_type: "1",
      token: '"3045"',
      last_traded_price: "12345",
      avg_traded_price: "12000",
      vol_traded: "100",
    });

    assert.equal(marketData.calls.length, 1);
    assert.equal(marketData.calls[0].symbol, "RELIANCE");
    assert.equal(marketData.calls[0].price, 123.45);

    // LTP of 0 must be dropped.
    FakeWebSocketV2.emitTick({
      exchange_type: "1",
      token: '"3045"',
      last_traded_price: "0",
      avg_traded_price: "12000",
      vol_traded: "100",
    });
    assert.equal(marketData.calls.length, 1);

    // Non-finite LTP (NaN) must be dropped.
    FakeWebSocketV2.emitTick({
      exchange_type: "1",
      token: '"3045"',
      last_traded_price: "NaN",
      avg_traded_price: "12000",
      vol_traded: "100",
    });
    assert.equal(marketData.calls.length, 1);

    await (service as unknown as { closeWebSocket(): Promise<void> }).closeWebSocket();
  });
});
