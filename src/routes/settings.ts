import { Router } from "express";
import { resolveSettingsRepository } from "../container";
import { HttpError } from "../utils/HttpError";
import logger from "../utils/logger";
import type { RiskLimits } from "../services/RiskManager";
import { userAuthMiddleware } from "../middleware/userAuth";
import type { AuthSession } from "../types/user";
import { riskLimitsSchema } from "../schemas/settings";

const router = Router();

// Apply authentication middleware to all settings routes
router.use(userAuthMiddleware);

// GET /api/settings - Get current risk limits
router.get("/", async (req, res, next) => {
    try {
        const repo = resolveSettingsRepository();
        const userId = (req as unknown as { user: AuthSession }).user.userId;
        const limits = repo.getRiskLimits(userId);
        res.json(limits);
    } catch (error) {
        next(error);
    }
});

// POST /api/settings - Update risk limits
router.post("/", async (req, res, next) => {
    try {
        const repo = resolveSettingsRepository();
        const userId = (req as unknown as { user: AuthSession }).user.userId;
        const currentLimits = repo.getRiskLimits(userId);

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


        await repo.saveRiskLimits(userId, newLimits);

        logger.info({ old: currentLimits, new: newLimits }, "Settings updated via API");
        res.json(newLimits);
    } catch (error) {
        next(error);
    }
});

// POST /api/settings/reset - Reset to defaults
router.post("/reset", async (req, res, next) => {
    try {
        const repo = resolveSettingsRepository();
        const userId = (req as unknown as { user: AuthSession }).user.userId;
        const defaults = await repo.resetToDefaults(userId);
        logger.warn("Settings reset to defaults via API");
        res.json(defaults);
    } catch (error) {
        next(error);
    }
});

export default router;
