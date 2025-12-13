import PaperBroker from "./brokers/PaperBroker";
import type BrokerClient from "./brokers/BrokerClient";
import ZerodhaBroker from "./brokers/ZerodhaBroker";
import AngelOneBroker from "./brokers/AngelOneBroker";
import env from "./config/env";
import { getPortfolioRepository, getSettingsRepository, getStopLossRepository, getAuditLogRepository } from "./persistence";
import MarketDataService from "./services/MarketDataService";
import PortfolioService from "./services/PortfolioService";
import TradingEngine from "./services/TradingEngine";
import HistoricalDataService from "./services/HistoricalDataService";
import PortfolioRebalancer from "./services/PortfolioRebalancer";
import ExecutionPlanner from "./services/ExecutionPlanner";
import AngelOneHistoricalProvider from "./providers/AngelOneHistoricalProvider";
import VWAPStrategy from "./strategies/VWAPStrategy";
import type { TickerClient } from "./services/TickerClient";
import AngelOneTickerService from "./services/AngelOneTickerService";
import ReconciliationService from "./services/ReconciliationService";
import { RiskManager } from "./services/RiskManager";
import { StopLossMonitor } from "./services/StopLossMonitor";
import { AuditLogService } from "./services/AuditLogService";
import { HealthService } from "./services/HealthService";
import { NotificationService } from "./services/NotificationService";
import { TunnelService } from "./services/TunnelService";
import { DiscordBotService } from "./services/DiscordBotService";
import type { SettingsRepository } from "./persistence/SettingsRepository";
import type { StopLossRepository } from "./persistence/StopLossRepository";
import type { AuditLogRepository } from "./persistence/AuditLogRepository";

export interface AppContainer {
  portfolioService: PortfolioService;
  marketDataService: MarketDataService;
  historicalDataService: HistoricalDataService;
  portfolioRebalancer: PortfolioRebalancer;
  executionPlanner: ExecutionPlanner;
  brokerClient: BrokerClient;
  tradingEngine: TradingEngine;
  tickerClient: TickerClient | null;
  reconciliationService: ReconciliationService;
  settingsRepository: SettingsRepository;
  stopLossRepository: StopLossRepository;
  auditLogRepository: AuditLogRepository;
  riskManager: RiskManager;
  stopLossMonitor: StopLossMonitor;
  auditLogService: AuditLogService;
  healthService: HealthService;
  notificationService: NotificationService;
  tunnelService: TunnelService;
  discordBotService: DiscordBotService;
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

/**
 * Build ticker service based on DATA_PROVIDER config
 * Uses Angel One's free WebSocket ticker for real-time market data
 */
const buildTicker = (marketData: MarketDataService): TickerClient | null => {
  // Use Angel One ticker if data provider is set to angelone
  if (env.dataProvider === "angelone" && env.angelOneApiKey) {
    return new AngelOneTickerService(marketData);
  }
  return null;
};

export const createContainer = (): AppContainer => {
  const portfolioService = new PortfolioService(getPortfolioRepository());
  const settingsRepository = getSettingsRepository();
  const stopLossRepository = getStopLossRepository();
  const marketDataService = new MarketDataService();
  const historicalDataService = buildHistoricalDataService();
  const portfolioRebalancer = new PortfolioRebalancer();
  const executionPlanner = new ExecutionPlanner();
  const brokerClient = buildBroker();
  const riskManager = new RiskManager(settingsRepository);
  const tradingEngine = new TradingEngine({
    broker: brokerClient,
    marketData: marketDataService,
    portfolioService,
    riskManager,
  });

  tradingEngine.registerStrategy(new VWAPStrategy());

  // Build ticker for real-time market data (uses DATA_PROVIDER config)
  const tickerClient = buildTicker(marketDataService);

  // Build reconciliation service for syncing with broker
  const reconciliationService = new ReconciliationService(brokerClient, portfolioService);

  // Build stop-loss monitor
  const stopLossMonitor = new StopLossMonitor({
    marketDataService,
    tradingEngine,
    stopLossRepository,
    riskManager,
  });

  // Build audit log service
  const auditLogRepository = getAuditLogRepository();
  const auditLogService = new AuditLogService({
    repository: auditLogRepository,
    tradingEngine,
    stopLossMonitor,
    settingsRepository,
  });

  // Build health service
  const healthService = new HealthService({
    brokerClient,
    tickerClient: tickerClient || undefined,
    marketDataService,
    stopLossMonitor,
  });

  // Build notification service (only if webhook configured)
  const notificationService = new NotificationService({
    discordWebhookUrl: env.discordWebhookUrl,
    webhookUrl: env.webhookUrl,
    tradingEngine,
    stopLossMonitor,
  });

  // Build remote access services
  const tunnelService = new TunnelService();

  const discordBotService = new DiscordBotService({
    token: env.discordBotToken,
    tunnelService,
  });

  return {
    portfolioService,
    marketDataService,
    historicalDataService,
    portfolioRebalancer,
    executionPlanner,
    brokerClient,
    tradingEngine,
    tickerClient,
    reconciliationService,
    settingsRepository,
    stopLossRepository,
    auditLogRepository,
    riskManager,
    stopLossMonitor,
    auditLogService,
    healthService,
    notificationService,
    tunnelService,
    discordBotService,
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

export const resolveTickerClient = (): TickerClient | null => getContainer().tickerClient;

export const resolveReconciliationService = (): ReconciliationService => getContainer().reconciliationService;

export const resolveSettingsRepository = (): SettingsRepository => getContainer().settingsRepository;

export const resolveStopLossRepository = (): StopLossRepository => getContainer().stopLossRepository;

export const resolveAuditLogRepository = (): AuditLogRepository => getContainer().auditLogRepository;

export const resolveRiskManager = (): RiskManager => getContainer().riskManager;

export const resolveStopLossMonitor = (): StopLossMonitor => getContainer().stopLossMonitor;

export const resolveAuditLogService = (): AuditLogService => getContainer().auditLogService;

export const resolveHealthService = (): HealthService => getContainer().healthService;

export const resolveNotificationService = (): NotificationService => getContainer().notificationService;

export const resolveDiscordBotService = (): DiscordBotService => getContainer().discordBotService;
