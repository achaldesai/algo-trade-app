import { Router } from "express";
import { TradingLoopService } from "../services/TradingLoopService";
import { resolveTradingEngine, resolveStopLossMonitor } from "../container";
import logger from "../utils/logger";
import { HttpError } from "../utils/HttpError";

const router = Router();

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
        // If service not initialized yet
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
        logger.warn("🚨 PANIC SELL TRIGGERED 🚨");

        // Stop the loop and stop-loss monitor first to prevent new orders
        try {
            const loop = TradingLoopService.getInstance();
            loop.stop();

            const stopLossMonitor = resolveStopLossMonitor();
            stopLossMonitor.stop();
        } catch (e) {
            // Ignore if services not init
        }

        const engine = resolveTradingEngine();
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

