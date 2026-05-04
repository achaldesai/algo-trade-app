import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getContainer } from "../util/getContainer";
import logger from "../utils/logger";
import { HttpError } from "../utils/HttpError";
import { adminAuthMiddleware } from "../middleware/adminAuth";

const router = Router();
router.use(adminAuthMiddleware);

router.get("/db-stats", async (req: Request, res: Response) => {
  try {
    const { dbManager } = getContainer(req);
    const stats = await dbManager.getStats();
    res.json({ backend: "lmdb", ...stats });
  } catch (error) {
    logger.error({ err: error }, "Failed to get database stats");
    throw new HttpError(500, "Failed to retrieve database statistics");
  }
});

router.post("/backup", async (req: Request, res: Response) => {
  try {
    const { dbManager } = getContainer(req);
    const backupPath = await dbManager.createBackup();
    logger.info({ backupPath }, "Manual backup created");
    res.json({ success: true, backupPath, createdAt: new Date().toISOString() });
  } catch (error) {
    logger.error({ err: error }, "Failed to create backup");
    throw new HttpError(500, "Failed to create database backup");
  }
});

router.get("/backups", async (req: Request, res: Response) => {
  try {
    const { dbManager } = getContainer(req);
    const backups = await dbManager.listBackups();
    res.json({
      count: backups.length,
      backups: backups.map((p: string) => ({ path: p, name: p.split("/").pop() })),
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to list backups");
    throw new HttpError(500, "Failed to list backups");
  }
});

const RestoreSchema = z.object({ backupPath: z.string().min(1) });

router.post("/restore", async (req: Request, res: Response) => {
  try {
    const { backupPath } = RestoreSchema.parse(req.body);
    const { dbManager } = getContainer(req);
    await dbManager.restoreFromBackup(backupPath);
    logger.info({ backupPath }, "Database restored from backup");
    res.json({ success: true, restoredFrom: backupPath, restoredAt: new Date().toISOString() });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    logger.error({ err: error }, "Failed to restore from backup");
    throw new HttpError(500, "Failed to restore database from backup");
  }
});

router.get("/export", async (req: Request, res: Response) => {
  try {
    const { dbManager } = getContainer(req);
    const data = await dbManager.exportToJson();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=portfolio-export.json");
    res.json(data);
  } catch (error) {
    logger.error({ err: error }, "Failed to export database");
    throw new HttpError(500, "Failed to export database");
  }
});

router.get("/health", async (req: Request, res: Response) => {
  try {
    const { healthService, autoTradingService } = getContainer(req);
    const health = await healthService.getHealth();
    const marketOpen = autoTradingService?.isMarketHours(new Date()) ?? false;
    const statusCode = health.status === "unhealthy" ? 503 : 200;
    res.status(statusCode).json({ ...health, marketOpen });
  } catch (error) {
    logger.error({ err: error }, "Health check failed");
    res.status(503).json({ status: "unhealthy", timestamp: new Date().toISOString(), error: "System health check failed" });
  }
});

export default router;
