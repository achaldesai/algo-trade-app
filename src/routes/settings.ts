import { Router } from "express";
import { resolveSettingsRepository } from "../container";
import { HttpError } from "../utils/HttpError";
import logger from "../utils/logger";
import type { RiskLimits } from "../services/RiskManager";

const router = Router();

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
        // Basic validation: ensure numbers are positive where appropriate
        const updates = req.body as Partial<RiskLimits>;

        const newLimits: RiskLimits = {
            ...currentLimits,
            maxDailyLoss: Number(updates.maxDailyLoss ?? currentLimits.maxDailyLoss),
            maxDailyLossPercent: Number(updates.maxDailyLossPercent ?? currentLimits.maxDailyLossPercent),
            maxPositionSize: Number(updates.maxPositionSize ?? currentLimits.maxPositionSize),
            maxOpenPositions: Number(updates.maxOpenPositions ?? currentLimits.maxOpenPositions),
            stopLossPercent: Number(updates.stopLossPercent ?? currentLimits.stopLossPercent)
        };

        if (newLimits.maxDailyLoss < 0) throw new HttpError(400, "Max daily loss must be positive");
        if (newLimits.maxPositionSize <= 0) throw new HttpError(400, "Max position size must be positive");

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
