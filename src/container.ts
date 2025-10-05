import PaperBroker from "./brokers/PaperBroker";
import type BrokerClient from "./brokers/BrokerClient";
import ZerodhaBroker from "./brokers/ZerodhaBroker";
import { seedStocks, seedTrades } from "./data/seed";
import env from "./config/env";
import MarketDataService from "./services/MarketDataService";
import PortfolioService from "./services/PortfolioService";
import TradingEngine from "./services/TradingEngine";
import VWAPStrategy from "./strategies/VWAPStrategy";

export const portfolioService = new PortfolioService(seedStocks, seedTrades);
export const marketDataService = new MarketDataService();

const buildBroker = (): BrokerClient => {
  switch (env.brokerProvider) {
    case "zerodha":
      return new ZerodhaBroker({ baseUrl: env.brokerBaseUrl, apiKey: env.brokerApiKey });
    default:
      return new PaperBroker();
  }
};

export const brokerClient = buildBroker();

export const tradingEngine = new TradingEngine({
  broker: brokerClient,
  marketData: marketDataService,
  portfolioService,
});

tradingEngine.registerStrategy(new VWAPStrategy());

export default portfolioService;
