import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getPortfolioRepository } from "../persistence";
import logger from "../utils/logger";
import { HttpError } from "../utils/HttpError";
import env from "../config/env";

const router = Router();

/**
 * GET /admin/db-stats
 * Get database statistics (size, record counts, etc.)
 */
router.get("/db-stats", async (req: Request, res: Response) => {
  try {
    const repo = await getPortfolioRepository();

    // Check if repository has stats method (LMDB only)
    if ('getStats' in repo && typeof repo.getStats === 'function') {
      const stats = await repo.getStats();
      res.json({
        backend: env.portfolioBackend,
        ...stats,
      });
    } else {
      // Fallback for file-based repository
      const stocks = await repo.listStocks();
      const trades = await repo.listTrades();

      res.json({
        backend: env.portfolioBackend,
        path: env.portfolioStorePath,
        stockCount: stocks.length,
        tradeCount: trades.length,
      });
    }
  } catch (error) {
    logger.error({ err: error }, "Failed to get database stats");
    throw new HttpError(500, "Failed to retrieve database statistics");
  }
});

/**
 * POST /admin/backup
 * Manually trigger a database backup
 */
router.post("/backup", async (req: Request, res: Response) => {
  try {
    const repo = await getPortfolioRepository();

    if ('createBackup' in repo && typeof repo.createBackup === 'function') {
      const backupPath = await repo.createBackup();
      logger.info({ backupPath }, "Manual backup created");

      res.json({
        success: true,
        backupPath,
        createdAt: new Date().toISOString(),
      });
    } else {
      throw new HttpError(400, "Backup functionality not available for current backend");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;

    logger.error({ err: error }, "Failed to create backup");
    throw new HttpError(500, "Failed to create database backup");
  }
});

/**
 * GET /admin/backups
 * List all available backups
 */
router.get("/backups", async (req: Request, res: Response) => {
  try {
    const repo = await getPortfolioRepository();

    if ('listBackups' in repo && typeof repo.listBackups === 'function') {
      const backups = await repo.listBackups();

      res.json({
        count: backups.length,
        backups: backups.map((path: string) => ({
          path,
          name: path.split('/').pop(),
        })),
      });
    } else {
      throw new HttpError(400, "Backup functionality not available for current backend");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;

    logger.error({ err: error }, "Failed to list backups");
    throw new HttpError(500, "Failed to list backups");
  }
});

/**
 * POST /admin/restore
 * Restore database from a backup
 * Body: { backupPath: string }
 */
const RestoreSchema = z.object({
  backupPath: z.string().min(1),
});

router.post("/restore", async (req: Request, res: Response) => {
  try {
    const { backupPath } = RestoreSchema.parse(req.body);
    const repo = await getPortfolioRepository();

    if ('restoreFromBackup' in repo && typeof repo.restoreFromBackup === 'function') {
      await repo.restoreFromBackup(backupPath);
      logger.info({ backupPath }, "Database restored from backup");

      res.json({
        success: true,
        restoredFrom: backupPath,
        restoredAt: new Date().toISOString(),
      });
    } else {
      throw new HttpError(400, "Restore functionality not available for current backend");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;

    logger.error({ err: error }, "Failed to restore from backup");
    throw new HttpError(500, "Failed to restore database from backup");
  }
});

/**
 * GET /admin/export
 * Export database to JSON format for inspection
 */
router.get("/export", async (req: Request, res: Response) => {
  try {
    const repo = await getPortfolioRepository();

    if ('exportToJson' in repo && typeof repo.exportToJson === 'function') {
      const data = await repo.exportToJson();

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=portfolio-export.json');
      res.json(data);
    } else {
      // Fallback: manually export
      const stocks = await repo.listStocks();
      const trades = await repo.listTrades();

      const data = {
        stocks,
        trades,
        exportedAt: new Date().toISOString(),
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=portfolio-export.json');
      res.json(data);
    }
  } catch (error) {
    logger.error({ err: error }, "Failed to export database");
    throw new HttpError(500, "Failed to export database");
  }
});

/**
 * GET /admin/health
 * Get overall system health status
 */
router.get("/health", async (req: Request, res: Response) => {
  try {
    const repo = await getPortfolioRepository();
    const stocks = await repo.listStocks();
    const trades = await repo.listTrades();

    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      backend: env.portfolioBackend,
      broker: env.brokerProvider,
      port: env.port,
      dataPath: env.portfolioStorePath,
      counts: {
        stocks: stocks.length,
        trades: trades.length,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "Health check failed");

    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      error: "System health check failed",
    });
  }
});

export default router;
