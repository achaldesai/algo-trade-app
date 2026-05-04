import { Router } from "express";
import { getContainer } from "../util/getContainer";
import { HttpError } from "../utils/HttpError";
import logger from "../utils/logger";
import { userAuthMiddleware } from "../middleware/userAuth";

const router = Router();
router.use(userAuthMiddleware);

router.get("/status", async (req, res, next) => {
    try {
        const { reconciliationService } = getContainer(req);
        const result = reconciliationService.getLastResult();

        if (!result) {
            reconciliationService.reconcilePeriodic().catch((err: Error) => {
                logger.error({ err }, "Failed to trigger periodic reconciliation from status check");
            });
            res.json({ status: "pending", message: "Reconciliation pending" });
            return;
        }

        res.json(result);
    } catch (error) {
        next(error);
    }
});

router.post("/run", async (req, res, next) => {
    try {
        const { reconciliationService } = getContainer(req);
        const result = await reconciliationService.reconcilePeriodic();
        res.json(result);
    } catch (error) {
        next(error);
    }
});

router.post("/sync/:symbol", async (req, res, next) => {
    try {
        const { symbol } = req.params;
        if (!symbol) {
            throw new HttpError(400, "Symbol is required");
        }

        const { reconciliationService } = getContainer(req);
        const userId = req.user!.userId;
        await reconciliationService.syncSymbolFromBroker(userId, symbol.toUpperCase());

        res.json({
            success: true,
            message: `Synced ${symbol} from broker`,
            result: reconciliationService.getLastResult(),
        });
    } catch (error) {
        next(error);
    }
});

export default router;
