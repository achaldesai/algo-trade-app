import { Router } from "express";
import { resolveStopLossMonitor } from "../container";
import type { StopLossConfig } from "../persistence/StopLossRepository";

const router = Router();

/**
 * GET /api/stop-loss
 * List all active stop-losses
 */
router.get("/", (_req, res) => {
    const monitor = resolveStopLossMonitor();
    const status = monitor.getStatus();

    res.json({
        success: true,
        data: {
            monitoring: status.monitoring,
            activeCount: status.activeStopLosses,
            stopLosses: status.stopLosses.map(formatStopLoss),
        },
    });
});

/**
 * GET /api/stop-loss/:symbol
 * Get stop-loss for a specific symbol
 */
router.get("/:symbol", (req, res): void => {
    const monitor = resolveStopLossMonitor();
    const symbol = req.params.symbol.toUpperCase();

    const stopLoss = monitor.get(symbol);

    if (!stopLoss) {
        res.status(404).json({
            success: false,
            error: `No stop-loss found for symbol ${symbol}`,
        });
        return;
    }

    res.json({
        success: true,
        data: formatStopLoss(stopLoss),
    });
});

/**
 * PUT /api/stop-loss/:symbol
 * Create or update stop-loss for a symbol
 * 
 * Body:
 * - stopLossPrice?: number (optional - uses default from settings if not provided)
 * - type?: 'FIXED' | 'TRAILING' (default: 'FIXED')
 * - trailingPercent?: number (required if type is 'TRAILING')
 * - entryPrice: number (required for new stop-losses)
 * - quantity: number (required for new stop-losses)
 */
router.put("/:symbol", async (req, res): Promise<void> => {
    const monitor = resolveStopLossMonitor();
    const symbol = req.params.symbol.toUpperCase();

    const { stopLossPrice, type, trailingPercent, entryPrice, quantity } = req.body;

    // Check if we have an existing stop-loss to update
    const existing = monitor.get(symbol);

    if (!existing && (entryPrice === undefined || quantity === undefined)) {
        res.status(400).json({
            success: false,
            error: "entryPrice and quantity are required for new stop-losses",
        });
        return;
    }

    try {
        const config = await monitor.setStopLoss(symbol, {
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
        res.status(500).json({
            success: false,
            error: message,
        });
    }
});

/**
 * DELETE /api/stop-loss/:symbol
 * Remove stop-loss for a symbol
 */
router.delete("/:symbol", async (req, res): Promise<void> => {
    const monitor = resolveStopLossMonitor();
    const symbol = req.params.symbol.toUpperCase();

    const existing = monitor.get(symbol);

    if (!existing) {
        res.status(404).json({
            success: false,
            error: `No stop-loss found for symbol ${symbol}`,
        });
        return;
    }

    try {
        await monitor.removeStopLoss(symbol);

        res.json({
            success: true,
            message: `Stop-loss removed for ${symbol}`,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to remove stop-loss";
        res.status(500).json({
            success: false,
            error: message,
        });
    }
});

/**
 * POST /api/stop-loss/start
 * Start the stop-loss monitor
 */
router.post("/start", (_req, res) => {
    const monitor = resolveStopLossMonitor();
    monitor.start();

    res.json({
        success: true,
        message: "Stop-loss monitor started",
        data: monitor.getStatus(),
    });
});

/**
 * POST /api/stop-loss/stop
 * Stop the stop-loss monitor
 */
router.post("/stop", (_req, res) => {
    const monitor = resolveStopLossMonitor();
    monitor.stop();

    res.json({
        success: true,
        message: "Stop-loss monitor stopped",
        data: monitor.getStatus(),
    });
});

/**
 * Format stop-loss config for API response
 */
function formatStopLoss(config: StopLossConfig) {
    return {
        symbol: config.symbol,
        entryPrice: config.entryPrice,
        stopLossPrice: config.stopLossPrice,
        quantity: config.quantity,
        type: config.type,
        trailingPercent: config.trailingPercent,
        highWaterMark: config.highWaterMark,
        distancePercent: Number(
            (((config.entryPrice - config.stopLossPrice) / config.entryPrice) * 100).toFixed(2)
        ),
        createdAt: config.createdAt.toISOString(),
        updatedAt: config.updatedAt.toISOString(),
    };
}

export default router;
