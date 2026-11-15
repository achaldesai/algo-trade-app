import { Router } from "express";
import { getContainer } from "../util/getContainer";
import { HttpError } from "../utils/HttpError";
import logger from "../utils/logger";
import type { RiskLimits } from "../db/repositories/SettingsRepo";
import { userAuthMiddleware } from "../middleware/userAuth";
import { riskLimitsSchema } from "../schemas/settings";
import { asyncHandler } from "../util/asyncHandler";
import { z } from "zod";

const router = Router();
router.use(userAuthMiddleware);

router.get("/", async (req, res, next) => {
    try {
        const { settingsRepo } = getContainer(req);
        const userId = req.user!.userId;
        const limits = settingsRepo.getRiskLimits(userId);
        res.json(limits);
    } catch (error) {
        next(error);
    }
});

router.post("/", async (req, res, next) => {
    try {
        const { settingsRepo } = getContainer(req);
        const userId = req.user!.userId;
        const currentLimits = settingsRepo.getRiskLimits(userId);

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
            stopLossPercent: updates.stopLossPercent ?? currentLimits.stopLossPercent,
        };

        await settingsRepo.saveRiskLimits(userId, newLimits);
        logger.info({ old: currentLimits, new: newLimits }, "Settings updated via API");
        res.json(newLimits);
    } catch (error) {
        next(error);
    }
});

router.post("/reset", async (req, res, next) => {
    try {
        const { settingsRepo } = getContainer(req);
        const userId = req.user!.userId;
        const defaults = await settingsRepo.resetToDefaults(userId);
        logger.warn("Settings reset to defaults via API");
        res.json(defaults);
    } catch (error) {
        next(error);
    }
});

// Paper mode's starting balance, used to size "% of equity" orders. Cash is
// this plus sells minus buys in the user's recorded trades.
router.get("/paper-cash", (req, res) => {
    res.json({ startingCash: getContainer(req).settingsRepo.getPaperStartingCash(req.user!.userId) });
});

const paperCashSchema = z.object({ startingCash: z.number().min(0).max(1e12) });

router.put(
    "/paper-cash",
    asyncHandler(async (req, res) => {
        const parsed = paperCashSchema.safeParse(req.body);
        if (!parsed.success) throw new HttpError(400, "'startingCash' must be a number from 0 to 1e12");
        await getContainer(req).settingsRepo.savePaperStartingCash(req.user!.userId, parsed.data.startingCash);
        res.json(parsed.data);
    }),
);

export default router;
