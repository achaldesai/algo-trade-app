import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createContainer,
  getContainer,
  resetContainer,
  resolvePortfolioService,
  resolveMarketDataService,
  resolveHistoricalDataService,
  resolvePortfolioRebalancer,
  resolveExecutionPlanner,
  resolveBrokerClient,
  resolveTradingEngine,
} from "./container";
import PortfolioService from "./services/PortfolioService";
import MarketDataService from "./services/MarketDataService";
import HistoricalDataService from "./services/HistoricalDataService";
import PortfolioRebalancer from "./services/PortfolioRebalancer";
import ExecutionPlanner from "./services/ExecutionPlanner";
import TradingEngine from "./services/TradingEngine";

describe("Container", () => {
  it("creates container with all required services", () => {
    const container = createContainer();

    assert.ok(container.portfolioService instanceof PortfolioService);
    assert.ok(container.marketDataService instanceof MarketDataService);
    assert.ok(container.historicalDataService instanceof HistoricalDataService);
    assert.ok(container.portfolioRebalancer instanceof PortfolioRebalancer);
    assert.ok(container.executionPlanner instanceof ExecutionPlanner);
    assert.ok(container.brokerClient);
    assert.ok(container.tradingEngine instanceof TradingEngine);
  });

  it("provides singleton access via getContainer", () => {
    const container1 = getContainer();
    const container2 = getContainer();

    // Should return the same instance
    assert.strictEqual(container1, container2);
    assert.strictEqual(container1.portfolioService, container2.portfolioService);
    assert.strictEqual(container1.marketDataService, container2.marketDataService);
    assert.strictEqual(container1.historicalDataService, container2.historicalDataService);
    assert.strictEqual(container1.portfolioRebalancer, container2.portfolioRebalancer);
    assert.strictEqual(container1.executionPlanner, container2.executionPlanner);
  });

  it("resets container properly", () => {
    const container1 = getContainer();
    const container2 = resetContainer();

    // Should return different instances after reset
    assert.notStrictEqual(container1, container2);
    assert.notStrictEqual(container1.portfolioService, container2.portfolioService);
    assert.notStrictEqual(container1.marketDataService, container2.marketDataService);
  });

  it("resolves portfolio service correctly", () => {
    const service = resolvePortfolioService();
    assert.ok(service instanceof PortfolioService);
  });

  it("resolves market data service correctly", () => {
    const service = resolveMarketDataService();
    assert.ok(service instanceof MarketDataService);
  });

  it("resolves historical data service correctly", () => {
    const service = resolveHistoricalDataService();
    assert.ok(service instanceof HistoricalDataService);
  });

  it("resolves portfolio rebalancer correctly", () => {
    const service = resolvePortfolioRebalancer();
    assert.ok(service instanceof PortfolioRebalancer);
  });

  it("resolves execution planner correctly", () => {
    const service = resolveExecutionPlanner();
    assert.ok(service instanceof ExecutionPlanner);
  });

  it("resolves broker client correctly", () => {
    const client = resolveBrokerClient();
    assert.ok(client);
    assert.equal(typeof client.name, "string");
    assert.equal(typeof client.connect, "function");
    assert.equal(typeof client.isConnected, "function");
  });

  it("resolves trading engine correctly", () => {
    const engine = resolveTradingEngine();
    assert.ok(engine instanceof TradingEngine);
  });

  it("trading engine has VWAP strategy registered", () => {
    const engine = resolveTradingEngine();
    const strategies = engine.getStrategies();

    assert.ok(strategies.length > 0);
    const vwapStrategy = strategies.find(s => s.id === "vwap");
    assert.ok(vwapStrategy);
    assert.equal(vwapStrategy.name, "VWAP Mean Reversion");
  });

  it("broker client implements required interface", () => {
    const broker = resolveBrokerClient();

    // Check interface compliance
    assert.equal(typeof broker.connect, "function");
    assert.equal(typeof broker.disconnect, "function");
    assert.equal(typeof broker.isConnected, "function");
    assert.equal(typeof broker.getPositions, "function");
    assert.equal(typeof broker.placeOrder, "function");
    assert.equal(typeof broker.cancelOrder, "function");
    assert.equal(typeof broker.getQuote, "function");
  });

  it("services are properly wired together", () => {
    const container = getContainer();

    // Trading engine should have references to other services
    assert.ok(container.tradingEngine);

    // All services should be instances of their respective classes
    assert.ok(container.portfolioService instanceof PortfolioService);
    assert.ok(container.marketDataService instanceof MarketDataService);
    assert.ok(container.historicalDataService instanceof HistoricalDataService);
    assert.ok(container.portfolioRebalancer instanceof PortfolioRebalancer);
    assert.ok(container.executionPlanner instanceof ExecutionPlanner);
  });
});