import { Router } from "express";
import { TradingLoopService } from "../services/TradingLoopService";
import { resolveTradingEngine, resolveStopLossMonitor } from "../container";
import logger from "../utils/logger";
import { HttpError } from "../utils/HttpError";
import { adminAuthMiddleware } from "../middleware/adminAuth";
import { getUserRepository } from "../persistence";

const router = Router();

// Apply authentication middleware to all control routes
router.use(adminAuthMiddleware);

router.get("/status", (req, res) => {
    try {
        const loopService = TradingLoopService.getInstance();
        const loopStatus = loopService.getStatus();

        const stopLossMonitor = resolveStopLossMonitor();
        const stopLossStatus = stopLossMonitor.getStatus();

        res.json({
            ...loopStatus,
            stopLoss: {
                monitoring: stopLossStatus.monitoring,
                activeCount: stopLossStatus.activeStopLosses,
            },
        });
    } catch (error) {
        // If service not initialized yet, just log debug
        logger.debug({ err: error }, "Status check failed (services might not be ready)");
        res.json({ running: false, mode: "parallel", evaluating: false, stopLoss: { monitoring: false, activeCount: 0 } });
    }
});

router.post("/start", (req, res) => {
    try {
        const loopService = TradingLoopService.getInstance();
        loopService.start();

        // Start stop-loss monitor alongside trading loop
        const stopLossMonitor = resolveStopLossMonitor();
        stopLossMonitor.start();

        res.json({ success: true, message: "Trading loop and stop-loss monitor started" });
    } catch (error) {
        logger.error({ err: error }, "Failed to start trading loop");
        throw new HttpError(500, "Failed to start trading loop");
    }
});

router.post("/stop", (req, res) => {
    try {
        const loopService = TradingLoopService.getInstance();
        loopService.stop();

        // Stop stop-loss monitor alongside trading loop
        const stopLossMonitor = resolveStopLossMonitor();
        stopLossMonitor.stop();

        res.json({ success: true, message: "Trading loop and stop-loss monitor stopped" });
    } catch (error) {
        logger.error({ err: error }, "Failed to stop trading loop");
        throw new HttpError(500, "Failed to stop trading loop");
    }
});

router.post("/panic-sell", async (req, res, next) => {
    try {
        if (!req.body || typeof req.body.confirmToken !== "string" || req.body.confirmToken !== "PANIC-CONFIRM") {
            res.status(400).json({ success: false, message: "Invalid confirmation token. Type 'PANIC-CONFIRM' to execute." });
            return;
        }

        logger.warn("🚨 PANIC SELL TRIGGERED 🚨");

        // Stop the loop and stop-loss monitor first to prevent new orders
        try {
            const loop = TradingLoopService.getInstance();
            loop.stop();

            const stopLossMonitor = resolveStopLossMonitor();
            stopLossMonitor.stop();
        } catch (error) {
            // Ignore if services not init but log it
            logger.debug({ err: error }, "Failed to stop services during panic sell (possibly not running)");
        }

        const engine = resolveTradingEngine();
        const users = await getUserRepository().listUsers();

        // Execute panic sell for each user
        let totalExecuted = 0;
        let totalFailed = 0;
        const resultsByUserId: Record<string, unknown> = {};

        for (const user of users) {
            try {
                const result = await engine.sellAllPositions(user.id);
                totalExecuted += result.executions.length;
                totalFailed += result.failures.length;
                resultsByUserId[user.id] = result;
            } catch (err) {
                logger.error({ err, userId: user.id }, "Panic sell failed for user");
            }
        }

        res.json({
            success: true,
            message: "Panic sell executed across all users",
            data: { executedCount: totalExecuted, failedCount: totalFailed, details: resultsByUserId },
        });
    } catch (error) {
        next(error);
    }
});

export default router;

