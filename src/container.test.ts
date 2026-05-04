import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import type { AppContainer } from "./container";
import type DatabaseManager from "./db/DatabaseManager";
import PortfolioService from "./services/PortfolioService";
import MarketDataService from "./services/MarketDataService";
import HistoricalDataService from "./services/HistoricalDataService";
import PortfolioRebalancer from "./services/PortfolioRebalancer";
import ExecutionPlanner from "./services/ExecutionPlanner";
import TradingEngine from "./services/TradingEngine";
import TokenRefreshService from "./services/TokenRefreshService";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createContainer } = require("./container") as {
  createContainer: (db: DatabaseManager) => AppContainer;
};

interface MockNamedDb {
  getRange: () => Array<{ key: string; value: unknown }>;
  get: (_key: string) => unknown;
  put: (_key: string, _value: unknown) => Promise<void>;
  remove: (_key: string) => Promise<void>;
}

function makeMockNamedDb(): MockNamedDb {
  return {
    getRange: () => [],
    get: () => undefined,
    put: async () => { },
    remove: async () => { },
  };
}

function makeMockDbManager(): DatabaseManager {
  const namedDb = makeMockNamedDb();
  return {
    handles: {
      stocks: namedDb,
      trades: namedDb,
      settings: namedDb,
      stopLosses: namedDb,
      auditLogs: namedDb,
      tokens: namedDb,
      users: namedDb,
      strategyConfigs: namedDb,
    },
    open: async () => { },
    close: async () => { },
  } as unknown as DatabaseManager;
}

const dbs: DatabaseManager[] = [];

async function makeContainer(): Promise<AppContainer> {
  const db = makeMockDbManager();
  await db.open();
  dbs.push(db);
  return createContainer(db);
}

describe("Container", () => {
  afterEach(async () => {
    for (const db of dbs) {
      try { await db.close(); } catch { /* ignore */ }
    }
    dbs.length = 0;
  });

  it("creates container with all required services", async () => {
    const container = await makeContainer();

    assert.ok(container.portfolioService instanceof PortfolioService);
    assert.ok(container.marketDataService instanceof MarketDataService);
    assert.ok(container.historicalDataService instanceof HistoricalDataService);
    assert.ok(container.portfolioRebalancer instanceof PortfolioRebalancer);
    assert.ok(container.executionPlanner instanceof ExecutionPlanner);
    assert.ok(container.brokerClient);
    assert.ok(container.tradingEngine instanceof TradingEngine);
  });

  it("container has all expected service keys", async () => {
    const container = await makeContainer();

    const expectedKeys = [
      "dbManager",
      "portfolioRepo",
      "settingsRepo",
      "stopLossRepo",
      "auditLogRepo",
      "tokenRepo",
      "userRepo",
      "strategyConfigRepo",
      "portfolioService",
      "marketDataService",
      "historicalDataService",
      "marketScannerService",
      "portfolioRebalancer",
      "executionPlanner",
      "brokerClient",
      "brokerFactory",
      "tradingEngine",
      "reconciliationService",
      "riskManager",
      "stopLossMonitor",
      "auditLogService",
      "healthService",
      "notificationService",
      "tunnelService",
      "discordBotService",
      "tradingLoopService",
      "autoTradingService",
      "tokenRefreshService",
    ];

    for (const key of expectedKeys) {
      assert.ok(key in container, `Container should have key '${key}'`);
    }
  });

  it("trading engine has VWAP strategy registered", async () => {
    const container = await makeContainer();
    const strategies = container.tradingEngine.getStrategies();

    assert.ok(strategies.length > 0);
    const vwapStrategy = strategies.find((s: { id: string }) => s.id === "vwap");
    assert.ok(vwapStrategy);
    assert.equal(vwapStrategy.name, "VWAP Mean Reversion");
  });

  it("broker client implements required interface", async () => {
    const container = await makeContainer();
    const broker = container.brokerClient;

    assert.equal(typeof broker.connect, "function");
    assert.equal(typeof broker.disconnect, "function");
    assert.equal(typeof broker.isConnected, "function");
    assert.equal(typeof broker.getPositions, "function");
    assert.equal(typeof broker.placeOrder, "function");
    assert.equal(typeof broker.cancelOrder, "function");
    assert.equal(typeof broker.getQuote, "function");
  });

  it("each createContainer call returns a fresh container", async () => {
    const container1 = await makeContainer();
    const container2 = await makeContainer();

    assert.notStrictEqual(container1, container2);
    assert.notStrictEqual(container1.portfolioService, container2.portfolioService);
    assert.notStrictEqual(container1.marketDataService, container2.marketDataService);
  });

  it("token refresh service is created and properly wired", async () => {
    const container = await makeContainer();
    assert.ok(container.tokenRefreshService instanceof TokenRefreshService);
    assert.equal(typeof container.tokenRefreshService.start, "function");
    assert.equal(typeof container.tokenRefreshService.stop, "function");
    assert.equal(typeof container.tokenRefreshService.refreshToken, "function");
  });
});