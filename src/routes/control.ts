import { Router } from "express";
import { getContainer } from "../util/getContainer";
import logger from "../utils/logger";
import { HttpError } from "../utils/HttpError";
import { adminAuthMiddleware } from "../middleware/adminAuth";
import { asyncHandler } from "../util/asyncHandler";

const router = Router();
router.use(adminAuthMiddleware);

router.get("/status", (req, res) => {
    try {
        const { tradingLoopService, stopLossMonitor, dailyStrategyRunner, autoTradingService } = getContainer(req);
        const loopStatus = tradingLoopService.getStatus();
        const stopLossStatus = stopLossMonitor.getStatus();

        res.json({
            ...loopStatus,
            dailyStrategies: dailyStrategyRunner.getStatus(),
            autoStart: autoTradingService.getAutoStartStatus(),
            stopLoss: {
                monitoring: stopLossStatus.monitoring,
                activeCount: stopLossStatus.activeStopLosses,
            },
        });
    } catch (error) {
        logger.debug({ err: error }, "Status check failed (services might not be ready)");
        res.json({ running: false, mode: "parallel", evaluating: false, stopLoss: { monitoring: false, activeCount: 0 } });
    }
});

router.post("/start", (req, res) => {
    try {
        const { tradingLoopService, stopLossMonitor, autoTradingService } = getContainer(req);
        autoTradingService.clearManualStop();
        tradingLoopService.start();
        stopLossMonitor.start();
        res.json({ success: true, message: "Trading loop and stop-loss monitor started" });
    } catch (error) {
        logger.error({ err: error }, "Failed to start trading loop");
        throw new HttpError(500, "Failed to start trading loop");
    }
});

router.post("/stop", (req, res) => {
    try {
        const { tradingLoopService, stopLossMonitor, autoTradingService } = getContainer(req);
        // Stays stopped: the morning auto-start won't switch it back on.
        autoTradingService.markManualStop();
        tradingLoopService.stop();
        stopLossMonitor.stop();
        res.json({ success: true, message: "Trading loop and stop-loss monitor stopped" });
    } catch (error) {
        logger.error({ err: error }, "Failed to stop trading loop");
        throw new HttpError(500, "Failed to stop trading loop");
    }
});

// Whether the 09:00 IST auto-trading routine may switch trading on by itself.
router.get("/auto-start", (req, res) => {
    res.json({ data: getContainer(req).autoTradingService.getAutoStartStatus() });
});

router.put("/auto-start", asyncHandler(async (req, res) => {
    if (typeof req.body?.enabled !== "boolean") throw new HttpError(400, "'enabled' must be true or false");
    const { settingsRepo, autoTradingService } = getContainer(req);
    await settingsRepo.saveAutoStartTrading(req.body.enabled);
    logger.warn({ enabled: req.body.enabled }, "Auto-start trading setting changed");
    res.json({ data: autoTradingService.getAutoStartStatus() });
}));

router.post("/panic-sell", async (req, res, next) => {
    try {
        if (!req.body || typeof req.body.confirmToken !== "string" || req.body.confirmToken !== "PANIC-CONFIRM") {
            res.status(400).json({ success: false, message: "Invalid confirmation token. Type 'PANIC-CONFIRM' to execute." });
            return;
        }

        logger.warn("🚨 PANIC SELL TRIGGERED 🚨");

        const { tradingLoopService, stopLossMonitor, tradingEngine, userRepo, stopLossRepo, autoTradingService } = getContainer(req);

        // Stop loop and monitor first, and keep them stopped until START.
        autoTradingService.markManualStop();
        try {
            tradingLoopService.stop();
            stopLossMonitor.stop();
        } catch (error) {
            logger.debug({ err: error }, "Failed to stop services during panic sell (possibly not running)");
        }

        let openPositions = 0;
        let closedCount = 0;
        let failedCount = 0;
        const users: Record<string, unknown> = {};

        for (const user of userRepo.listUsers()) {
            try {
                const result = await tradingEngine.sellAllPositions(user.id);
                openPositions += result.openPositions;
                closedCount += result.closed.length;
                failedCount += result.failures.length;
                // A closed position needs no stop-loss.
                for (const symbol of result.closed) await stopLossRepo.delete(user.id, symbol);
                users[user.id] = {
                    openPositions: result.openPositions,
                    closed: result.closed,
                    failures: result.failures.map((f) => ({ symbol: f.request.symbol, side: f.request.side, quantity: f.request.quantity, error: f.error })),
                    notes: result.notes,
                };
            } catch (err) {
                failedCount++;
                users[user.id] = { error: err instanceof Error ? err.message : "Panic sell failed" };
                logger.error({ err, userId: user.id }, "Panic sell failed for user");
            }
        }

        // Only "success" when nothing is left open that should have closed.
        const success = failedCount === 0;
        const message = openPositions === 0
            ? "Panic sell: no open positions"
            : `Panic sell: closed ${closedCount} of ${openPositions} open positions${failedCount ? `, ${failedCount} failed` : ""}`;
        logger.warn({ openPositions, closedCount, failedCount }, message);

        res.status(success ? 200 : 207).json({
            success,
            message,
            data: { openPositions, closedCount, failedCount, users },
        });
    } catch (error) {
        next(error);
    }
});

export default router;
