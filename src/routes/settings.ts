import { Router } from "express";
import { resolveSettingsRepository } from "../container";
import { HttpError } from "../utils/HttpError";
import logger from "../utils/logger";
import type { RiskLimits } from "../services/RiskManager";
import { adminAuthMiddleware } from "../middleware/adminAuth";
import { riskLimitsSchema } from "../schemas/settings";

const router = Router();

// Apply authentication middleware to all settings routes
router.use(adminAuthMiddleware);

// GET /api/settings - Get current risk limits
router.get("/", async (_req, res, next) => {
    try {
        const repo = resolveSettingsRepository();
        const limits = repo.getRiskLimits();
        res.json(limits);
    } catch (error) {
        next(error);
    }
});

// POST /api/settings - Update risk limits
router.post("/", async (req, res, next) => {
    try {
        const repo = resolveSettingsRepository();
        const currentLimits = repo.getRiskLimits();

        // Validate and merge settings
        const validationResult = riskLimitsSchema.safeParse(req.body);

        if (!validationResult.success) {
            throw new HttpError(400, validationResult.error.errors.map(e => e.message).join(", "));
        }

        const updates = validationResult.data;

        const newLimits: RiskLimits = {
            ...currentLimits,
            maxDailyLoss: updates.maxDailyLoss ?? currentLimits.maxDailyLoss,
            maxDailyLossPercent: updates.maxDailyLossPercent ?? currentLimits.maxDailyLossPercent,
            maxPositionSize: updates.maxPositionSize ?? currentLimits.maxPositionSize,
            maxOpenPositions: updates.maxOpenPositions ?? currentLimits.maxOpenPositions,
            stopLossPercent: updates.stopLossPercent ?? currentLimits.stopLossPercent
        };


        await repo.saveRiskLimits(newLimits);

        logger.info({ old: currentLimits, new: newLimits }, "Settings updated via API");
        res.json(newLimits);
    } catch (error) {
        next(error);
    }
});

// POST /api/settings/reset - Reset to defaults
router.post("/reset", async (_req, res, next) => {
    try {
        const repo = resolveSettingsRepository();
        const defaults = await repo.resetToDefaults();
        logger.warn("Settings reset to defaults via API");
        res.json(defaults);
    } catch (error) {
        next(error);
    }
});

export default router;
