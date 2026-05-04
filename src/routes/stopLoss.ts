import { Router } from "express";
import { getContainer } from "../util/getContainer";
import type { StopLossConfig } from "../db/repositories/StopLossRepo";
import { userAuthMiddleware } from "../middleware/userAuth";

const router = Router();
router.use(userAuthMiddleware);

router.get("/", (req, res) => {
    const { stopLossMonitor } = getContainer(req);
    const userId = req.user!.userId;
    const status = stopLossMonitor.getStatus(userId);

    res.json({
        success: true,
        data: {
            monitoring: status.monitoring,
            activeCount: status.activeStopLosses,
            stopLosses: status.stopLosses.map(formatStopLoss),
        },
    });
});

router.get("/:symbol", (req, res): void => {
    const { stopLossMonitor } = getContainer(req);
    const userId = req.user!.userId;
    const symbol = req.params.symbol.toUpperCase();

    const stopLoss = stopLossMonitor.get(userId, symbol);

    if (!stopLoss) {
        res.status(404).json({ success: false, error: `No stop-loss found for symbol ${symbol}` });
        return;
    }

    res.json({ success: true, data: formatStopLoss(stopLoss) });
});

router.put("/:symbol", async (req, res): Promise<void> => {
    const { stopLossMonitor } = getContainer(req);
    const userId = req.user!.userId;
    const symbol = req.params.symbol.toUpperCase();
    const { stopLossPrice, type, trailingPercent, entryPrice, quantity } = req.body;

    const existing = stopLossMonitor.get(userId, symbol);

    if (!existing && (entryPrice === undefined || quantity === undefined)) {
        res.status(400).json({ success: false, error: "entryPrice and quantity are required for new stop-losses" });
        return;
    }

    try {
        const config = await stopLossMonitor.setStopLoss(userId, symbol, {
            entryPrice: entryPrice ?? existing?.entryPrice ?? 0,
            quantity: quantity ?? existing?.quantity ?? 0,
            stopLossPrice,
            type: type ?? existing?.type,
            trailingPercent: trailingPercent ?? existing?.trailingPercent,
        });

        res.json({
            success: true,
            data: formatStopLoss(config),
            message: existing ? "Stop-loss updated" : "Stop-loss created",
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to set stop-loss";
        res.status(500).json({ success: false, error: message });
    }
});

router.delete("/:symbol", async (req, res): Promise<void> => {
    const { stopLossMonitor } = getContainer(req);
    const userId = req.user!.userId;
    const symbol = req.params.symbol.toUpperCase();

    const existing = stopLossMonitor.get(userId, symbol);
    if (!existing) {
        res.status(404).json({ success: false, error: `No stop-loss found for symbol ${symbol}` });
        return;
    }

    try {
        await stopLossMonitor.removeStopLoss(userId, symbol);
        res.json({ success: true, message: `Stop-loss removed for ${symbol}` });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to remove stop-loss";
        res.status(500).json({ success: false, error: message });
    }
});

router.post("/start", (req, res) => {
    const { stopLossMonitor } = getContainer(req);
    stopLossMonitor.start();
    res.json({ success: true, message: "Stop-loss monitor started", data: stopLossMonitor.getStatus() });
});

router.post("/stop", (req, res) => {
    const { stopLossMonitor } = getContainer(req);
    stopLossMonitor.stop();
    res.json({ success: true, message: "Stop-loss monitor stopped", data: stopLossMonitor.getStatus() });
});

function formatStopLoss(config: StopLossConfig) {
    return {
        symbol: config.symbol,
        entryPrice: config.entryPrice,
        stopLossPrice: config.stopLossPrice,
        quantity: config.quantity,
        type: config.type,
        trailingPercent: config.trailingPercent,
        highWaterMark: config.highWaterMark,
        distancePercent: Number((((config.entryPrice - config.stopLossPrice) / config.entryPrice) * 100).toFixed(2)),
        createdAt: config.createdAt.toISOString(),
        updatedAt: config.updatedAt.toISOString(),
    };
}

export default router;
