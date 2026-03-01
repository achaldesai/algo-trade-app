import http from "http";
import app from "./app";
import env from "./config/env";
import validateEnvironment from "./config/validateEnv";
import logger from "./utils/logger";
import { ensurePortfolioStore, ensureSettingsStore, ensureStopLossStore, ensureAuditLogStore, ensureUserStore, getPortfolioRepository } from "./persistence";
import { getInstrumentMasterService } from "./services/InstrumentMasterService";
import { TokenMigrationService } from "./services/TokenMigrationService";
import { TokenRefreshService } from "./services/TokenRefreshService";

const server = http.createServer(app);

// Backup interval tracking
let backupInterval: NodeJS.Timeout | null = null;

/**
 * Schedules automatic database backups
 * Default: Daily backups at the interval specified
 */
const scheduleBackups = async () => {
  const backupIntervalHours = Number(process.env.BACKUP_INTERVAL_HOURS) || 24;
  const backupIntervalMs = backupIntervalHours * 60 * 60 * 1000;

  const performBackup = async () => {
    try {
      const repo = getPortfolioRepository();

      // Only LMDB repository has backup functionality
      if ('createBackup' in repo && typeof repo.createBackup === 'function') {
        const backupPath = await repo.createBackup();
        logger.info({ backupPath }, "Database backup created successfully");
      }
    } catch (error) {
      logger.error({ err: error }, "Failed to create database backup");
    }
  };

  // Create initial backup on startup
  await performBackup();

  // Schedule recurring backups
  backupInterval = setInterval(performBackup, backupIntervalMs);

  logger.info({ intervalHours: backupIntervalHours }, "Automatic backups scheduled");
};

const start = async () => {
  try {
    await validateEnvironment(env);
    await ensurePortfolioStore();
    await ensureSettingsStore();
    await ensureStopLossStore();
    await ensureAuditLogStore();
    await ensureUserStore();

    // Migrate tokens from file-based storage to LMDB (one-time operation)
    const migrationService = new TokenMigrationService();
    await migrationService.migrate(env.portfolioStorePath);

    // Initialize auth state (now per-user, we don't do this globally on startup anymore)
    // AuthService.getInstance().initialize() is removed.

    // Check initial position sync (you may want to scope this per active user later)
    if (env.brokerProvider !== "paper") {
      const { resolveBrokerClient } = await import("./container");
      const broker = resolveBrokerClient();

      await broker.connect();

      if (!broker.isConnected()) {
        logger.error({
          brokerProvider: env.brokerProvider
        }, "FATAL: Broker not authenticated. Run authentication first.");
        process.exit(1);
      }
      logger.info({ broker: broker.name }, "Broker authentication verified");
    }

    // For ticker (DATA_PROVIDER=angelone), validate Angel One tokens exist
    let tickerTokensValid = false;
    if (env.dataProvider === "angelone") {
      const { loadAngelToken } = await import("./routes/auth");
      const { TokenRefreshService } = await import("./services/TokenRefreshService");
      const refreshService = TokenRefreshService.getInstance();
      let angelTokens = await loadAngelToken("SYSTEM_DEFAULT");

      if (!angelTokens) {
        if (env.angelOneTotpSecret) {
          logger.info("Angel One tokens missing or expired. Attempting automatic re-authentication...");
          try {
            await refreshService.refreshToken("SYSTEM_DEFAULT");
            angelTokens = await loadAngelToken("SYSTEM_DEFAULT");
          } catch (error) {
            logger.warn({ err: error }, "Automatic Angel One re-authentication failed");
          }
        }
        logger.warn("Angel One tokens not found. Ticker will not start. Authenticate via /api/auth/angelone/login");
      } else {
        // Check token expiry
        const expiresAt = new Date(angelTokens.expiresAt);
        if (expiresAt < new Date()) {
          logger.warn({ expiresAt }, "Angel One tokens expired. Ticker will not start. Re-authenticate via /api/auth/angelone/login");
        } else {
          tickerTokensValid = true;
          logger.info("Angel One token validation passed");
        }
      }
    }


    if (env.brokerProvider === "angelone" || env.dataProvider === "angelone") {
      try {
        const instrumentService = getInstrumentMasterService();
        await instrumentService.loadInstrumentMaster();
      } catch (error) {
        logger.warn({ err: error }, "Failed to load instrument master (will retry on first API call)");
      }
    }

    const { resolveTickerClient } = await import("./container");
    const tickerClient = resolveTickerClient();
    if (tickerClient && tickerTokensValid) {
      // Connect ticker (will load tokens internally)
      tickerClient.connect().catch(err => {
        logger.error({ err }, "Failed to connect ticker on startup");
      });
      logger.info("Ticker service initialized");

      // Subscribe to watchlist symbols
      if (env.watchlist.length > 0) {
        // Ensure instrument master is loaded
        const instrumentService = getInstrumentMasterService();
        if (!instrumentService.isReady()) {
          await instrumentService.loadInstrumentMaster();
        }

        const exchange = env.angelOneDefaultExchange;
        let subscribedCount = 0;

        for (const symbol of env.watchlist) {
          const token = instrumentService.getToken(symbol, exchange);
          if (token) {
            tickerClient.subscribe({
              exchange,
              symbol,
              symbolToken: token,
            });
            subscribedCount++;
          } else {
            logger.warn({ symbol, exchange }, "Skipping watchlist subscription: Instrument token not found");
          }
        }

        if (subscribedCount > 0) {
          logger.info({ count: subscribedCount, symbols: env.watchlist }, "Subscribed to watchlist symbols");
        }
      }
    } else if (tickerClient && !tickerTokensValid) {
      logger.info("Ticker service not started - authenticate first");
    }

    // Start backup scheduler
    await scheduleBackups();

    // Start automatic token refresh scheduler (Angel One only)
    const tokenRefreshService = TokenRefreshService.getInstance();
    tokenRefreshService.start();

    // Reconcile positions with broker on startup (critical for consistency)
    const { resolveReconciliationService } = await import("./container");
    const reconciliationService = resolveReconciliationService();
    try {
      const result = await reconciliationService.reconcileOnStartup();
      if (result.hasDiscrepancies) {
        logger.warn(
          { discrepancies: result.discrepancies.length, synced: result.syncedSymbols.length },
          "Position discrepancies found - check dashboard for details"
        );
      }
    } catch (err) {
      logger.error({ err }, "Position reconciliation failed on startup");
    }

    // Initialize Trading Loop Service (but don't start it yet)
    const {
      resolveMarketDataService,
      resolveTradingEngine,
      resolveStopLossMonitor,
      resolveRiskManager,
      resolveNotificationService,
      resolveMarketScannerService,
      resolveTickerClient: resTicker,
      resolvePortfolioService,
      resolveUserRepository
    } = await import("./container");
    const { TradingLoopService } = await import("./services/TradingLoopService");
    const { AutoTradingService } = await import("./services/AutoTradingService");

    const userRepository = await resolveUserRepository();
    TradingLoopService.getInstance(resolveMarketDataService(), resolveTradingEngine(), userRepository);
    logger.info("Trading loop service initialized");

    const stopLossMonitor = resolveStopLossMonitor();
    const autoTradingService = AutoTradingService.getInstance(
      resolveMarketScannerService(),
      resTicker(),
      stopLossMonitor,
      resolvePortfolioService(),
      userRepository
    );
    autoTradingService.start();
    logger.info("Auto-trading service started");

    const riskManager = resolveRiskManager();
    const notificationService = resolveNotificationService();
    riskManager.on("critical_error", (event: { type: string; error: Error }) => {
      logger.error({ event }, "CRITICAL ERROR: System may require manual intervention");
      void notificationService.notifyCriticalError(
        event.type,
        event.error?.message || "Unknown error"
      );
    });

    // Initialize Stop-Loss Monitor (starts automatically with trading loop)
    logger.info("Stop-loss monitor initialized");

    const { resolveDiscordBotService } = await import("./container");
    const discordBotService = resolveDiscordBotService();
    void discordBotService.start();

    server.listen(env.port, () => {
      logger.info({ port: env.port }, "HTTP server is listening");
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to start server");
    process.exit(1);
  }
};

void start();

const shutdown = (signal: string) => {
  logger.info({ signal }, "Received shutdown signal");

  // Clear backup interval
  if (backupInterval) {
    clearInterval(backupInterval);
    backupInterval = null;
  }

  // Stop token refresh scheduler
  const tokenRefreshService = TokenRefreshService.getInstance();
  tokenRefreshService.stop();

  // Stop auto-trading service
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AutoTradingService } = require("./services/AutoTradingService");
    AutoTradingService.getInstance().stop();
  } catch (_err) {
    // Service might not be initialized
  }

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, "Error during shutdown");
      process.exitCode = 1;
    }
    logger.info("Server closed");
    process.exit();
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
