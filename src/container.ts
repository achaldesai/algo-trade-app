import PaperBroker from "./brokers/PaperBroker";
import type BrokerClient from "./brokers/BrokerClient";
import ZerodhaBroker from "./brokers/ZerodhaBroker";
import AngelOneBroker from "./brokers/AngelOneBroker";
import env from "./config/env";
import { getPortfolioRepository } from "./persistence";
import MarketDataService from "./services/MarketDataService";
import PortfolioService from "./services/PortfolioService";
import TradingEngine from "./services/TradingEngine";
import HistoricalDataService from "./services/HistoricalDataService";
import PortfolioRebalancer from "./services/PortfolioRebalancer";
import ExecutionPlanner from "./services/ExecutionPlanner";
import AngelOneHistoricalProvider from "./providers/AngelOneHistoricalProvider";
import VWAPStrategy from "./strategies/VWAPStrategy";

export interface AppContainer {
  portfolioService: PortfolioService;
  marketDataService: MarketDataService;
  historicalDataService: HistoricalDataService;
  portfolioRebalancer: PortfolioRebalancer;
  executionPlanner: ExecutionPlanner;
  brokerClient: BrokerClient;
  tradingEngine: TradingEngine;
}

const buildBroker = (): BrokerClient => {
  switch (env.brokerProvider) {
    case "zerodha":
      return new ZerodhaBroker({
        apiKey: env.brokerApiKey,
        apiSecret: env.brokerApiSecret,
        accessToken: env.brokerAccessToken,
        requestToken: env.brokerRequestToken,
        defaultExchange: env.brokerDefaultExchange,
        product: env.brokerProduct,
      });
    case "angelone":
      return new AngelOneBroker({
        apiKey: env.angelOneApiKey,
        clientId: env.angelOneClientId,
        password: env.angelOnePassword,
        totpSecret: env.angelOneTotpSecret,
        defaultExchange: env.angelOneDefaultExchange,
        productType: env.angelOneProductType,
      });
    default:
      return new PaperBroker();
  }
};

const buildHistoricalDataService = (): HistoricalDataService => {
  // Use Angel One provider if broker is set to angelone
  if (env.brokerProvider === "angelone" && env.angelOneApiKey) {
    const provider = new AngelOneHistoricalProvider({
      apiKey: env.angelOneApiKey,
      clientId: env.angelOneClientId,
      password: env.angelOnePassword,
      totpSecret: env.angelOneTotpSecret,
    });
    return new HistoricalDataService(undefined, provider);
  }

  // Default to mock provider
  return new HistoricalDataService();
};

export const createContainer = (): AppContainer => {
  const portfolioService = new PortfolioService(getPortfolioRepository());
  const marketDataService = new MarketDataService();
  const historicalDataService = buildHistoricalDataService();
  const portfolioRebalancer = new PortfolioRebalancer();
  const executionPlanner = new ExecutionPlanner();
  const brokerClient = buildBroker();
  const tradingEngine = new TradingEngine({
    broker: brokerClient,
    marketData: marketDataService,
    portfolioService,
  });

  tradingEngine.registerStrategy(new VWAPStrategy());

  return {
    portfolioService,
    marketDataService,
    historicalDataService,
    portfolioRebalancer,
    executionPlanner,
    brokerClient,
    tradingEngine,
  };
};

let activeContainer: AppContainer | null = null;

export const getContainer = (): AppContainer => {
  if (!activeContainer) {
    activeContainer = createContainer();
  }

  return activeContainer;
};

export const resetContainer = (): AppContainer => {
  activeContainer = createContainer();
  return activeContainer;
};

export const resolvePortfolioService = (): PortfolioService => getContainer().portfolioService;

export const resolveMarketDataService = (): MarketDataService => getContainer().marketDataService;

export const resolveHistoricalDataService = (): HistoricalDataService => getContainer().historicalDataService;

export const resolvePortfolioRebalancer = (): PortfolioRebalancer => getContainer().portfolioRebalancer;

export const resolveExecutionPlanner = (): ExecutionPlanner => getContainer().executionPlanner;

export const resolveBrokerClient = (): BrokerClient => getContainer().brokerClient;

export const resolveTradingEngine = (): TradingEngine => getContainer().tradingEngine;
