import http from "http";
import app from "./app";
import env from "./config/env";
import validateEnvironment from "./config/validateEnv";
import logger from "./utils/logger";
import { ensurePortfolioStore, getPortfolioRepository } from "./persistence";
import { AuthService } from "./services/AuthService";
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
      const repo = await getPortfolioRepository();

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

    // Migrate tokens from file-based storage to LMDB (one-time operation)
    const migrationService = new TokenMigrationService();
    await migrationService.migrate(env.portfolioStorePath);

    // Initialize authentication service (loads saved tokens)
    const authService = AuthService.getInstance();
    await authService.initialize();

    // Load Angel One instrument master if using angelone broker
    if (env.brokerProvider === "angelone") {
      try {
        logger.info("Loading Angel One instrument master...");
        const instrumentService = getInstrumentMasterService();
        await instrumentService.loadInstrumentMaster();
        logger.info({ count: instrumentService.getInstrumentCount() }, "Instrument master loaded");
      } catch (error) {
        logger.warn({ err: error }, "Failed to load instrument master (will retry on first API call)");
      }
    }

    // Start backup scheduler
    await scheduleBackups();

    // Start automatic token refresh scheduler (Angel One only)
    const tokenRefreshService = TokenRefreshService.getInstance();
    tokenRefreshService.start();

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
