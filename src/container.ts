import PaperBroker from "./brokers/PaperBroker";
import type BrokerClient from "./brokers/BrokerClient";
import ZerodhaBroker from "./brokers/ZerodhaBroker";
import AngelOneBroker from "./brokers/AngelOneBroker";
import { BrokerFactory } from "./brokers/BrokerFactory";
import env from "./config/env";
import { DatabaseManager } from "./db/DatabaseManager";
import { PortfolioRepo } from "./db/repositories/PortfolioRepo";
import { SettingsRepo } from "./db/repositories/SettingsRepo";
import { StopLossRepo } from "./db/repositories/StopLossRepo";
import { AuditLogRepo } from "./db/repositories/AuditLogRepo";
import { TokenRepo } from "./db/repositories/TokenRepo";
import { UserRepo } from "./db/repositories/UserRepo";
import { StrategyConfigRepo } from "./db/repositories/StrategyConfigRepo";
import type { RiskLimits } from "./db/repositories/SettingsRepo";
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
import { MarketScannerService } from "./services/MarketScannerService";
import { TradingLoopService } from "./services/TradingLoopService";
import { AutoTradingService } from "./services/AutoTradingService";

// PostgreSQL & Redis (optional)
import { PostgresManager } from "./db/postgres/PostgresManager";
import { PgUserRepo } from "./db/postgres/PgUserRepo";
import { PgTradeRepo } from "./db/postgres/PgTradeRepo";
import { PgAuditLogRepo } from "./db/postgres/PgAuditLogRepo";
import { RedisManager } from "./db/redis/RedisManager";
import { RedisCacheService } from "./db/redis/RedisCacheService";
import { RedisSessionStore } from "./db/redis/RedisSessionStore";
import logger from "./utils/logger";

// ─── Container Interface ─────────────────────────────────────────────────────

export interface AppContainer {
  // Database
  dbManager: DatabaseManager;
  portfolioRepo: PortfolioRepo;
  settingsRepo: SettingsRepo;
  stopLossRepo: StopLossRepo;
  auditLogRepo: AuditLogRepo;
  tokenRepo: TokenRepo;
  userRepo: UserRepo;
  strategyConfigRepo: StrategyConfigRepo;

  // Services
  portfolioService: PortfolioService;
  marketDataService: MarketDataService;
  historicalDataService: HistoricalDataService;
  marketScannerService: MarketScannerService;
  portfolioRebalancer: PortfolioRebalancer;
  executionPlanner: ExecutionPlanner;
  brokerClient: BrokerClient;
  tradingEngine: TradingEngine;
  tickerClient: TickerClient | null;
  reconciliationService: ReconciliationService;
  riskManager: RiskManager;
  stopLossMonitor: StopLossMonitor;
  auditLogService: AuditLogService;
  healthService: HealthService;
  notificationService: NotificationService;
  tunnelService: TunnelService;
  discordBotService: DiscordBotService;
  tradingLoopService: TradingLoopService;
  autoTradingService: AutoTradingService;

  // Optional: PostgreSQL layer (available when DATABASE_URL is set)
  postgresManager?: PostgresManager;
  pgUserRepo?: PgUserRepo;
  pgTradeRepo?: PgTradeRepo;
  pgAuditLogRepo?: PgAuditLogRepo;

  // Optional: Redis layer (available when REDIS_URL is set)
  redisManager?: RedisManager;
  cacheService?: RedisCacheService;
  sessionStore?: RedisSessionStore;
}

// ─── Factory Functions ───────────────────────────────────────────────────────

function buildBroker(): BrokerClient {
  switch (env.brokerProvider) {
    case "zerodha":
      return new ZerodhaBroker({
        apiKey: env.brokerApiKey,
        apiSecret: env.brokerApiSecret,
        accessToken:
          env.brokerAccessToken || process.env.ZERODHA_ACCESS_TOKEN,
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
}

function buildHistoricalDataService(): HistoricalDataService {
  if (env.brokerProvider === "angelone" && env.angelOneApiKey) {
    const provider = new AngelOneHistoricalProvider({
      apiKey: env.angelOneApiKey,
      clientId: env.angelOneClientId,
      password: env.angelOnePassword,
      totpSecret: env.angelOneTotpSecret,
    });
    return new HistoricalDataService(undefined, provider);
  }
  return new HistoricalDataService();
}

function buildTicker(
  marketData: MarketDataService
): TickerClient | null {
  if (env.dataProvider === "angelone" && env.angelOneApiKey) {
    return new AngelOneTickerService(marketData);
  }
  return null;
}

// ─── Container Creation ──────────────────────────────────────────────────────

/**
 * Create the application's dependency container.
 *
 * All dependencies are created eagerly and wired together.
 * No singletons, no static getInstance() — everything is explicit.
 *
 * @param dbManager - The open DatabaseManager instance
 */
export function createContainer(dbManager: DatabaseManager): AppContainer {
  // ── Repositories ─────────────────────────────────────────────────────────

  const portfolioRepo = new PortfolioRepo(dbManager);

  const defaultRiskLimits: RiskLimits = {
    maxDailyLoss: env.maxDailyLoss,
    maxDailyLossPercent: env.maxDailyLossPercent,
    maxPositionSize: env.maxPositionSize,
    maxOpenPositions: env.maxOpenPositions,
    stopLossPercent: env.stopLossPercent,
  };

  const settingsRepo = new SettingsRepo(dbManager, defaultRiskLimits);
  settingsRepo.load(); // Populate cache from LMDB

  const stopLossRepo = new StopLossRepo(dbManager);
  stopLossRepo.load(); // Populate cache from LMDB

  const auditLogRepo = new AuditLogRepo(dbManager);
  const tokenRepo = new TokenRepo(dbManager);
  const userRepo = new UserRepo(dbManager);

  const strategyConfigRepo = new StrategyConfigRepo(dbManager);
  strategyConfigRepo.load(); // Populate cache from LMDB

  // ── Core Services ────────────────────────────────────────────────────────

  const portfolioService = new PortfolioService(portfolioRepo);
  const marketDataService = new MarketDataService();
  const historicalDataService = buildHistoricalDataService();
  const marketScannerService = new MarketScannerService(
    historicalDataService
  );
  const portfolioRebalancer = new PortfolioRebalancer();
  const executionPlanner = new ExecutionPlanner();
  const brokerClient = buildBroker();

  const riskManager = new RiskManager(settingsRepo);

  const tradingEngine = new TradingEngine({
    brokerFactory: (userId: string) => BrokerFactory.getBroker(userId),
    fallbackBroker: new PaperBroker(),
    marketData: marketDataService,
    portfolioService,
    riskManager,
  });

  tradingEngine.registerStrategy(new VWAPStrategy());

  const tickerClient = buildTicker(marketDataService);

  const reconciliationService = new ReconciliationService(
    (userId: string) => BrokerFactory.getBroker(userId),
    portfolioService,
    userRepo
  );

  // ── Monitors & Safety ────────────────────────────────────────────────────

  const stopLossMonitor = new StopLossMonitor({
    marketDataService,
    tradingEngine,
    stopLossRepository: stopLossRepo,
    riskManager,
  });

  // ── Audit & Observability ────────────────────────────────────────────────

  const auditLogService = new AuditLogService({
    repository: auditLogRepo,
    tradingEngine,
    stopLossMonitor,
    settingsRepository: settingsRepo,
  });

  const notificationService = new NotificationService({
    discordWebhookUrl: env.discordWebhookUrl,
    webhookUrl: env.webhookUrl,
    tradingEngine,
    stopLossMonitor,
  });

  // ── Risk → Notification Wiring ───────────────────────────────────────────

  riskManager.on(
    "critical_error",
    (event: { type: string; error: Error }) => {
      void notificationService.notifyCriticalError(
        event.type,
        event.error?.message || "Unknown error"
      );
    }
  );

  // ── Remote Access ────────────────────────────────────────────────────────

  const tunnelService = new TunnelService();
  const discordBotService = new DiscordBotService({
    token: env.discordBotToken,
    tunnelService,
  });

  // ── Trading Automation ───────────────────────────────────────────────────

  const tradingLoopService = new TradingLoopService(
    marketDataService,
    tradingEngine,
    userRepo,
    strategyConfigRepo
  );

  const autoTradingService = new AutoTradingService(
    marketScannerService,
    tickerClient,
    stopLossMonitor,
    portfolioService,
    userRepo,
    tradingLoopService
  );

  // ── Health (created after tradingLoopService) ────────────────────────────

  const healthService = new HealthService({
    brokerClient,
    tickerClient: tickerClient || undefined,
    marketDataService,
    stopLossMonitor,
    tradingLoopService,
    portfolioRepo: portfolioRepo,
  });

  return {
    dbManager,
    portfolioRepo,
    settingsRepo,
    stopLossRepo,
    auditLogRepo,
    tokenRepo,
    userRepo,
    strategyConfigRepo,
    portfolioService,
    marketDataService,
    historicalDataService,
    marketScannerService,
    portfolioRebalancer,
    executionPlanner,
    brokerClient,
    tradingEngine,
    tickerClient,
    reconciliationService,
    riskManager,
    stopLossMonitor,
    auditLogService,
    healthService,
    notificationService,
    tunnelService,
    discordBotService,
    tradingLoopService,
    autoTradingService,
  };
}

/**
 * Initialize optional PostgreSQL and Redis connections on the container.
 * Call after createContainer() during server startup.
 */
export async function initOptionalStores(container: AppContainer): Promise<void> {
  // PostgreSQL
  if (env.databaseUrl) {
    try {
      const postgresManager = new PostgresManager(env.databaseUrl, {
        min: env.pgPoolMin,
        max: env.pgPoolMax,
      });
      await postgresManager.connect();

      container.postgresManager = postgresManager;
      container.pgUserRepo = new PgUserRepo(postgresManager.pool);
      container.pgTradeRepo = new PgTradeRepo(postgresManager.pool);
      container.pgAuditLogRepo = new PgAuditLogRepo(postgresManager.pool);

      logger.info("PostgreSQL layer initialized");
    } catch (err) {
      logger.error({ err }, "PostgreSQL initialization failed — falling back to LMDB");
    }
  }

  // Redis
  if (env.redisUrl) {
    try {
      const redisManager = new RedisManager(env.redisUrl);
      await redisManager.connect();

      container.redisManager = redisManager;
      container.cacheService = new RedisCacheService(redisManager);
      container.sessionStore = new RedisSessionStore(redisManager);

      logger.info("Redis layer initialized");
    } catch (err) {
      logger.error({ err }, "Redis initialization failed — falling back to in-memory");
    }
  }
}

/**
 * Gracefully shut down optional stores.
 */
export async function closeOptionalStores(container: AppContainer): Promise<void> {
  if (container.redisManager) {
    await container.redisManager.close();
  }
  if (container.postgresManager) {
    await container.postgresManager.close();
  }
}
