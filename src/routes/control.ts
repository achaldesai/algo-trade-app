import { Router } from "express";
import { TradingLoopService } from "../services/TradingLoopService";
import { resolveTradingEngine, resolveStopLossMonitor } from "../container";
import logger from "../utils/logger";
import { HttpError } from "../utils/HttpError";
import { adminAuthMiddleware } from "../middleware/adminAuth";

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
        const broker = engine.getActiveBroker();

        // Check broker availability before executing panic sell
        if (!broker.isConnected()) {
            logger.warn("Broker disconnected during panic sell, attempting reconnect...");
            try {
                await broker.connect();
            } catch (err) {
                logger.error({ err }, "Failed to connect broker for panic sell");
                res.status(503).json({
                    success: false,
                    message: "Broker unavailable - manual intervention required"
                });
                return;
            }
        }

        const result = await engine.sellAllPositions();

        res.json({
            success: true,
            message: "Panic sell executed",
            data: result,
        });
    } catch (error) {
        next(error);
    }
});

export default router;

