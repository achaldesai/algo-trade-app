import { Router } from "express";
import { resolveReconciliationService } from "../container";
import { HttpError } from "../utils/HttpError";
import logger from "../utils/logger";

const router = Router();

// GET /api/reconciliation/status - Get last reconciliation result
router.get("/status", async (_req, res, next) => {
    try {
        const service = resolveReconciliationService();
        const result = service.getLastResult();

        // If no result yet (e.g. very fresh startup), trigger one non-blocking if not running
        if (!result) {
            service.reconcilePeriodic().catch(err => {
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

// POST /api/reconciliation/run - Manually trigger reconciliation
router.post("/run", async (_req, res, next) => {
    try {
        const service = resolveReconciliationService();
        const result = await service.reconcilePeriodic();
        res.json(result);
    } catch (error) {
        next(error);
    }
});

// POST /api/reconciliation/sync/:symbol - Sync specific symbol from broker
router.post("/sync/:symbol", async (req, res, next) => {
    try {
        const { symbol } = req.params;
        if (!symbol) {
            throw new HttpError(400, "Symbol is required");
        }

        const service = resolveReconciliationService();
        await service.syncSymbolFromBroker(symbol.toUpperCase());

        res.json({
            success: true,
            message: `Synced ${symbol} from broker`,
            result: service.getLastResult()
        });
    } catch (error) {
        next(error);
    }
});

export default router;
