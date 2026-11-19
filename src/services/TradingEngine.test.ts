import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type BrokerClient from "../brokers/BrokerClient";
import type {
  BrokerOrderExecution,
  BrokerOrderRequest,
  PortfolioSnapshot,
  StrategySignal,
  Trade,
} from "../types";
import MarketDataService from "./MarketDataService";
import type PortfolioService from "./PortfolioService";
import TradingEngine from "./TradingEngine";
import PaperBroker from "../brokers/PaperBroker";
import BaseStrategy, { type StrategyContext, type StrategyParamDefinition } from "../strategies/BaseStrategy";
import { RiskManager } from "./RiskManager";
import type AccountService from "./AccountService";
import type { SettingsRepo } from "../db/repositories/SettingsRepo";

function createTestRiskManager(): RiskManager {
  const mockSettings = {
    getRiskLimits: () => ({
      maxDailyLoss: 100000,
      maxDailyLossPercent: 10,
      maxPositionSize: 100000,
      maxOpenPositions: 50,
      stopLossPercent: 3,
    }),
    on: () => { },
    saveRiskLimits: async () => { },
  } as unknown as SettingsRepo;
  return new RiskManager(mockSettings);
}

class FailingBroker implements BrokerClient {
  public readonly name = "failing";
  public connectAttempts = 0;

  async connect(): Promise<void> {
    this.connectAttempts += 1;
    throw new Error("connect failed");
  }

  async disconnect(): Promise<void> { }

  isConnected(): boolean {
    return false;
  }

  async getPositions(): Promise<Trade[]> {
    return [];
  }

  async placeOrder(_order: BrokerOrderRequest): Promise<BrokerOrderExecution> {
    throw new Error("primary broker should not execute orders");
  }

  async cancelOrder(_orderId: string): Promise<void> { }

  async getQuote(): Promise<null> {
    return null;
  }
}

class PlaceOrderFailingBroker implements BrokerClient {
  public readonly name = "place-order-failing";
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getPositions(): Promise<Trade[]> {
    return [];
  }

  async placeOrder(_order: BrokerOrderRequest): Promise<BrokerOrderExecution> {
    throw new Error("placeOrder rejected");
  }

  async cancelOrder(_orderId: string): Promise<void> { }

  async getQuote(): Promise<null> {
    return null;
  }
}

class TestStrategy extends BaseStrategy {
  constructor(private readonly expectedBroker: BrokerClient) {
    super("test-strategy", "Test Strategy", "Exercise broker fallback");
  }

  getParamSchema(): StrategyParamDefinition[] { return []; }
  getDefaultParams(): Record<string, unknown> { return {}; }

  async generateSignals(context: StrategyContext): Promise<StrategySignal[]> {
    assert.equal(context.broker, this.expectedBroker);
    return [
      {
        strategyId: this.id,
        description: "Buy AAPL via fallback",
        requestedOrders: [
          {
            symbol: "AAPL",
            side: "BUY",
            quantity: 1,
            price: 150,
            type: "MARKET",
          },
        ],
      },
    ];
  }
}

class GuardStrategy extends BaseStrategy {
  constructor() {
    super("guard-strategy", "Guard Strategy", "Should never execute when brokers are unavailable");
  }

  getParamSchema(): StrategyParamDefinition[] { return []; }
  getDefaultParams(): Record<string, unknown> { return {}; }

  async generateSignals(): Promise<StrategySignal[]> {
    throw new Error("generateSignals should not run when both brokers fail");
  }
}

const createPortfolioServiceStub = () => {
  const recorded: Trade[] = [];

  const service = {
    async getSnapshot(): Promise<PortfolioSnapshot> {
      return {
        generatedAt: new Date(),
        positions: [],
        totalTrades: recorded.length,
      } satisfies PortfolioSnapshot;
    },
    async recordExternalTrade(trade: Trade): Promise<void> {
      recorded.push(trade);
    },
  } as unknown as PortfolioService;

  return { service, recorded };
};

describe("TradingEngine broker fallback", () => {
  it("fails closed (no trades) when the broker cannot connect", async () => {
    const failingBroker = new FailingBroker();
    const { service: portfolioService, recorded } = createPortfolioServiceStub();
    const marketData = new MarketDataService();
    const riskManager = createTestRiskManager();

    const engine = new TradingEngine({
      brokerFactory: async () => failingBroker,
      portfolioService,
      marketData,
      riskManager,
    });

    const unavailableEvents: unknown[] = [];
    engine.on("broker-unavailable", (data) => unavailableEvents.push(data));

    engine.registerStrategy(new GuardStrategy());

    const result = await engine.evaluate("guard-strategy", "test-user");

    assert.equal(failingBroker.connectAttempts, 1);
    assert.equal(result.executions.length, 0);
    assert.equal(recorded.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].stage, "BROKER_CONNECTION");
    assert.match(result.errors[0].message, /connect failed/i);
    assert.equal(unavailableEvents.length, 1);
  });

  it("does not record a phantom trade and emits trade-failed when placeOrder rejects", async () => {
    const broker = new PlaceOrderFailingBroker();
    const { service: portfolioService, recorded } = createPortfolioServiceStub();
    const marketData = new MarketDataService();
    const riskManager = createTestRiskManager();

    const engine = new TradingEngine({
      brokerFactory: async () => broker,
      portfolioService,
      marketData,
      riskManager,
    });

    const failedEvents: unknown[] = [];
    engine.on("trade-failed", (data) => failedEvents.push(data));

    const strategy = new TestStrategy(broker);
    engine.registerStrategy(strategy);

    const result = await engine.evaluate(strategy.id, "test-user");

    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0].failures.length, 1);
    assert.equal(recorded.length, 0);
    assert.equal(failedEvents.length, 1);
  });

  it("does not execute a skipped signal (no orders)", async () => {
    const broker = new PlaceOrderFailingBroker();
    const engine = new TradingEngine({
      brokerFactory: async () => broker,
      portfolioService: createPortfolioServiceStub().service,
      marketData: new MarketDataService(),
      riskManager: createTestRiskManager(),
    });
    class SkippingStrategy extends TestStrategy {
      override async generateSignals(): Promise<StrategySignal[]> {
        return [{ strategyId: this.id, description: "BUY AAPL skipped", requestedOrders: [], skippedReason: "budget" }];
      }
    }
    const strategy = new SkippingStrategy(broker);
    engine.registerStrategy(strategy);

    const result = await engine.evaluate(strategy.id, "test-user");
    assert.deepEqual(result.executions, []);
    assert.deepEqual(result.errors, []);
  });

  it("passes the account to the strategy only when asked", async () => {
    const broker = new PlaceOrderFailingBroker();
    const seen: unknown[] = [];
    class AccountProbe extends TestStrategy {
      override async generateSignals(context: StrategyContext): Promise<StrategySignal[]> {
        seen.push(context.account);
        return [];
      }
    }
    const engine = new TradingEngine({
      brokerFactory: async () => broker,
      portfolioService: createPortfolioServiceStub().service,
      marketData: new MarketDataService(),
      riskManager: createTestRiskManager(),
      accountService: { getAccount: async () => ({ cash: 5000, equity: 8000 }) } as unknown as AccountService,
    });
    const strategy = new AccountProbe(broker);
    engine.registerStrategy(strategy);

    await engine.evaluate(strategy.id, "u1");
    await engine.evaluate(strategy.id, "u1", undefined, { withAccount: true });
    assert.deepEqual(seen, [undefined, { cash: 5000, equity: 8000 }]);
  });

  it("throttles broker-unavailable alerts to one per cooldown window", async () => {
    const failingBroker = new FailingBroker();
    const { service: portfolioService } = createPortfolioServiceStub();
    const marketData = new MarketDataService();
    const riskManager = createTestRiskManager();

    const engine = new TradingEngine({
      brokerFactory: async () => failingBroker,
      portfolioService,
      marketData,
      riskManager,
    });

    const unavailableEvents: unknown[] = [];
    engine.on("broker-unavailable", (data) => unavailableEvents.push(data));

    engine.registerStrategy(new GuardStrategy());

    await engine.evaluate("guard-strategy", "test-user");
    await engine.evaluate("guard-strategy", "test-user");

    assert.equal(unavailableEvents.length, 1);
  });
});

// ─── Panic sell (ACH-34) ─────────────────────────────────────────────────────

describe("TradingEngine.sellAllPositions", () => {
  /** A ledger that nets trades per symbol, like PortfolioService. */
  function ledgerOf(initial: Array<[string, "BUY" | "SELL", number, number]>) {
    let seq = 0;
    const trades: Trade[] = initial.map(([symbol, side, quantity, price]) => ({
      id: `t${seq++}`,
      symbol,
      side,
      quantity,
      price,
      executedAt: new Date(Date.UTC(2026, 10, 16, 4, seq)),
    }));
    const service = {
      listTrades: () => [...trades].sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime()),
      getSnapshot: () => {
        const net = new Map<string, number>();
        for (const t of trades) net.set(t.symbol, (net.get(t.symbol) ?? 0) + (t.side === "BUY" ? t.quantity : -t.quantity));
        return {
          generatedAt: new Date(),
          totalTrades: trades.length,
          positions: [...net].map(([symbol, netQuantity]) => ({ symbol, netQuantity, averageEntryPrice: 0, unrealizedPnl: 0 })),
        };
      },
      recordExternalTrade: async (_userId: string, trade: Trade) => void trades.push({ ...trade, executedAt: new Date(Date.UTC(2026, 10, 19, 16, seq++)) }),
    } as unknown as PortfolioService;
    const net = () => Object.fromEntries(
      (service.getSnapshot("u") as PortfolioSnapshot).positions.filter((p) => p.netQuantity !== 0).map((p) => [p.symbol, p.netQuantity]),
    );
    return { service, trades, net };
  }

  const engineWith = (broker: BrokerClient, portfolioService: PortfolioService) =>
    new TradingEngine({
      brokerFactory: async () => broker,
      portfolioService,
      marketData: new MarketDataService(),
      riskManager: createTestRiskManager(),
    });

  it("closes the ledger's net positions on a restarted paper broker, at the last ledger price", async () => {
    // The 2026-11-19 case: five 10-share longs, server restarted, no live ticks.
    const ledger = ledgerOf([
      ["HEROMOTOCO", "BUY", 10, 5600],
      ["HINDALCO", "BUY", 10, 926],
      ["APOLLOHOSP", "BUY", 10, 8720],
      ["BAJFINANCE", "BUY", 10, 1010],
      ["INDUSINDBK", "BUY", 10, 980],
    ]);
    const broker = new PaperBroker(); // fresh: no in-memory trades, no price feed
    const result = await engineWith(broker, ledger.service).sellAllPositions("u");

    assert.equal(result.openPositions, 5);
    assert.deepEqual([...result.closed].sort(), ["APOLLOHOSP", "BAJFINANCE", "HEROMOTOCO", "HINDALCO", "INDUSINDBK"]);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(ledger.net(), {}, "the ledger is flat afterwards");
    const apollo = result.executions.find((e) => e.request.symbol === "APOLLOHOSP")!;
    assert.deepEqual([apollo.request.side, apollo.request.quantity], ["SELL", 10]);
    assert.equal(apollo.averagePrice, Number((8720 * (1 - 0.0005)).toFixed(4)), "last ledger price less slippage");
  });

  it("sells the net quantity, skips flat symbols, and covers a short with a BUY", async () => {
    const ledger = ledgerOf([
      ["TCS", "BUY", 10, 2400],
      ["TCS", "SELL", 4, 2450],
      ["INFY", "BUY", 5, 1140],
      ["INFY", "SELL", 5, 1150],
      ["ITC", "SELL", 3, 400],
    ]);
    const result = await engineWith(new PaperBroker(), ledger.service).sellAllPositions("u");
    assert.deepEqual(
      result.executions.map((e) => [e.request.symbol, e.request.side, e.request.quantity]).sort(),
      [["ITC", "BUY", 3], ["TCS", "SELL", 6]],
    );
    assert.deepEqual(ledger.net(), {});
  });

  it("caps each close at what the broker really holds, and leaves holdings the app didn't buy", async () => {
    const ledger = ledgerOf([
      ["TCS", "BUY", 10, 2400],
      ["INFY", "BUY", 10, 1140],
      ["RELIANCE", "BUY", 5, 1340],
    ]);
    const placed: string[] = [];
    const broker = {
      name: "zerodha",
      connect: async () => undefined,
      isConnected: () => true,
      // INFY: only 4 left at the broker; RELIANCE: none; WIPRO: the user's own holding.
      getHoldings: async () => [
        { symbol: "TCS", quantity: 10 },
        { symbol: "INFY", quantity: 4 },
        { symbol: "WIPRO", quantity: 50 },
      ],
      placeOrder: async (order: BrokerOrderRequest) => {
        placed.push(`${order.side} ${order.quantity} ${order.symbol}`);
        return { id: order.symbol, request: order, status: "FILLED", filledQuantity: order.quantity, averagePrice: 100, executedAt: new Date() };
      },
    } as unknown as BrokerClient;

    const result = await engineWith(broker, ledger.service).sellAllPositions("u");
    assert.deepEqual(placed.sort(), ["SELL 10 TCS", "SELL 4 INFY"].sort());
    assert.deepEqual(result.notes.sort(), ["INFY: ledger 10, broker 4; closing 4", "RELIANCE: ledger 5, broker 0; closing 0"]);
    assert.deepEqual(result.closed.sort(), ["INFY", "TCS"]);
  });

  it("closes the ledger quantities, with a note, when the broker can't report holdings", async () => {
    const ledger = ledgerOf([["TCS", "BUY", 10, 2400]]);
    const broker = {
      name: "zerodha",
      connect: async () => undefined,
      isConnected: () => true,
      getHoldings: async () => null,
      placeOrder: async (order: BrokerOrderRequest) => ({ id: "x", request: order, status: "FILLED", filledQuantity: order.quantity, averagePrice: 2400, executedAt: new Date() }),
    } as unknown as BrokerClient;
    const result = await engineWith(broker, ledger.service).sellAllPositions("u");
    assert.deepEqual(result.closed, ["TCS"]);
    assert.deepEqual(result.notes, ["Broker holdings unavailable: closing the ledger quantities unverified"]);
  });

  it("reports a rejected or partly filled close as a failure, and still closes the rest", async () => {
    const ledger = ledgerOf([
      ["TCS", "BUY", 10, 2400],
      ["INFY", "BUY", 10, 1140],
      ["ITC", "BUY", 10, 400],
    ]);
    const broker = {
      name: "paper",
      connect: async () => undefined,
      isConnected: () => true,
      placeOrder: async (order: BrokerOrderRequest) => {
        if (order.symbol === "INFY") throw new Error("RMS: order rejected");
        const filled = order.symbol === "ITC" ? 6 : order.quantity;
        return { id: order.symbol, request: order, status: filled < order.quantity ? "PARTIALLY_FILLED" : "FILLED", filledQuantity: filled, averagePrice: 100, executedAt: new Date() };
      },
    } as unknown as BrokerClient;
    const result = await engineWith(broker, ledger.service).sellAllPositions("u");
    assert.deepEqual(result.closed, ["TCS"]);
    assert.deepEqual(
      result.failures.map((f) => [f.request.symbol, f.error]).sort(),
      [["INFY", "RMS: order rejected"], ["ITC", "Only 6 of 10 filled (PARTIALLY_FILLED)"]],
    );
    assert.deepEqual(ledger.net(), { INFY: 10, ITC: 4 }, "partial fills are still recorded");
  });
});

// ─── WATCHLIST-only default and paper cash (ACH-35) ──────────────────────────

describe("TradingEngine: symbol filter and paper cash", () => {
  class ScriptStrategy extends BaseStrategy {
    seenSymbols: string[] = [];
    constructor(private readonly orders: BrokerOrderRequest[]) {
      super("script", "Script", "test");
    }
    getParamSchema(): StrategyParamDefinition[] { return []; }
    getDefaultParams(): Record<string, unknown> { return {}; }
    async generateSignals(context: StrategyContext): Promise<StrategySignal[]> {
      this.seenSymbols = context.market.ticks.map((t) => t.symbol);
      return this.orders.length ? [{ strategyId: this.id, description: "", requestedOrders: this.orders }] : [];
    }
  }

  function setup(orders: BrokerOrderRequest[], cash: number) {
    const marketData = new MarketDataService();
    for (const [symbol, price] of [["INFY", 870], ["TCS", 1000], ["UPL", 536]] as const) {
      marketData.updateTick({ symbol, price, volume: 1 });
    }
    const broker = new PaperBroker((s) => marketData.getTick(s)?.price);
    const strategy = new ScriptStrategy(orders);
    const engine = new TradingEngine({
      brokerFactory: async () => broker,
      portfolioService: createPortfolioServiceStub().service,
      marketData,
      riskManager: createTestRiskManager(),
      accountService: { getAccount: async () => ({ cash, equity: cash }) } as unknown as AccountService,
    });
    engine.registerStrategy(strategy);
    return { engine, strategy };
  }
  const prices: Record<string, number> = { INFY: 870, TCS: 1000, UPL: 536 };
  // Strategies always send the signal price, which the risk check needs.
  const buy = (symbol: string, quantity: number): BrokerOrderRequest => ({ symbol, side: "BUY", quantity, type: "MARKET", price: prices[symbol] });

  it("shows the strategy only the allowed symbols' ticks", async () => {
    const { engine, strategy } = setup([], 100_000);
    await engine.evaluate("script", "u1", undefined, { symbols: ["TCS", "INFY"] });
    assert.deepEqual(strategy.seenSymbols.sort(), ["INFY", "TCS"], "the scanner pick UPL is hidden");
    await engine.evaluate("script", "u1");
    assert.deepEqual(strategy.seenSymbols.sort(), ["INFY", "TCS", "UPL"], "no filter: everything");
  });

  it("rejects a paper buy that costs more than the paper cash", async () => {
    const { engine } = setup([buy("INFY", 10)], 5000);
    const result = await engine.evaluate("script", "u1");
    assert.deepEqual(result.executions[0].executions, []);
    assert.equal(result.errors[0].message, "Insufficient paper cash: need ₹8700.00, have ₹5000.00");
  });

  it("fills a paper buy that fits, and spends the cash down across one signal", async () => {
    const fits = setup([buy("INFY", 5)], 5000);
    assert.equal((await fits.engine.evaluate("script", "u1")).executions[0].executions[0].filledQuantity, 5);

    // ₹5,000: the first 3 × ₹1,000 fills (₹3,001.50 with 5 bps slippage), the second can't.
    const two = setup([buy("TCS", 3), buy("TCS", 3)], 5000);
    const result = await two.engine.evaluate("script", "u1");
    assert.equal(result.executions[0].executions.length, 1);
    assert.equal(result.errors[0].message, "Insufficient paper cash: need ₹3000.00, have ₹1998.50");
  });

  it("never blocks a paper sell", async () => {
    const { engine } = setup([{ symbol: "TCS", side: "SELL", quantity: 10, type: "MARKET", price: 1000 }], 0);
    const result = await engine.evaluate("script", "u1");
    assert.equal(result.executions[0].executions[0].filledQuantity, 10);
    assert.deepEqual(result.errors, []);
  });
});
