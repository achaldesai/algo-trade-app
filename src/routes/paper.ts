import { Router, type Request, type Response, type NextFunction } from "express";
import env from "../config/env";
import { getContainer } from "../util/getContainer";
import logger from "../utils/logger";
import type {
    Trade,
    PortfolioPositionSnapshot,
} from "../types";

/**
 * The paper console is a debug-only surface — only available when the service
 * is running in paper mode (PAPER_TRADING=true or BROKER_PROVIDER=paper).
 * It does not require auth because it is meant for local debugging.
 */
function isPaperMode(): boolean {
    return env.paperTrading || env.brokerProvider === "paper";
}

/**
 * Guard middleware: returns 404 when not in paper mode, so the page is
 * indistinguishable from a non-existent route in production-like deployments.
 */
export function paperModeOnly(
    _req: Request,
    res: Response,
    next: NextFunction
): void {
    if (!isPaperMode()) {
        res.status(404).end();
        return;
    }
    next();
}

const router = Router();

router.use(paperModeOnly);

/**
 * GET /api/paper/pnl
 * Aggregated P&L + positions + today's orders across all users.
 * Used by the debug console at /orders.html.
 */
router.get("/pnl", (req: Request, res: Response, next: NextFunction) => {
    try {
        const { portfolioService, marketDataService, userRepo } =
            getContainer(req);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayEnd = new Date(today);
        todayEnd.setHours(23, 59, 59, 999);

        const users = userRepo.listUsers();
        // If there are no registered users yet, fall back to SYSTEM_DEFAULT so
        // the console works on a fresh local install.
        const userIds =
            users.length > 0 ? users.map((u) => u.id) : ["SYSTEM_DEFAULT"];

        const allTrades: Trade[] = [];
        const positionMap = new Map<string, PortfolioPositionSnapshot>();
        let realizedPnL = 0;

        for (const userId of userIds) {
            allTrades.push(...portfolioService.listTrades(userId));
            realizedPnL += portfolioService.getRealizedPnl(userId, today);

            const snapshot = portfolioService.getSnapshot(userId);
            for (const pos of snapshot.positions) {
                if (pos.netQuantity === 0) continue;
                // Aggregate same-symbol positions across users (debug view).
                const existing = positionMap.get(pos.symbol);
                if (!existing) {
                    positionMap.set(pos.symbol, { ...pos });
                } else {
                    const totalQty = existing.netQuantity + pos.netQuantity;
                    const blendedAvg =
                        totalQty === 0
                            ? existing.averageEntryPrice
                            : (existing.averageEntryPrice *
                                  existing.netQuantity +
                                  pos.averageEntryPrice * pos.netQuantity) /
                              totalQty;
                    positionMap.set(pos.symbol, {
                        ...existing,
                        netQuantity: totalQty,
                        averageEntryPrice: Number(blendedAvg.toFixed(2)),
                        realizedPnl: existing.realizedPnl + pos.realizedPnl,
                        unrealizedPnl:
                            existing.unrealizedPnl + pos.unrealizedPnl,
                    });
                }
            }
        }

        const todaysTrades = allTrades.filter((t) => {
            const ts = new Date(t.executedAt);
            return ts >= today && ts <= todayEnd;
        });

        let unrealizedPnL = 0;
        const positions = Array.from(positionMap.values()).map((pos) => {
            const liveTick = marketDataService.getTick(pos.symbol);
            let currentPrice = pos.averageEntryPrice;
            let unrealized = pos.unrealizedPnl;
            if (liveTick && pos.netQuantity !== 0) {
                currentPrice = liveTick.price;
                unrealized =
                    pos.netQuantity * (liveTick.price - pos.averageEntryPrice);
                unrealized = Number(unrealized.toFixed(2));
            }
            unrealizedPnL += unrealized;
            return {
                symbol: pos.symbol,
                quantity: pos.netQuantity,
                entryPrice: pos.averageEntryPrice,
                currentPrice,
                unrealizedPnl: unrealized,
                realizedPnl: pos.realizedPnl,
                position: pos.position,
            };
        });

        const totalPnL = realizedPnL + unrealizedPnL;

        res.json({
            success: true,
            data: {
                date: today.toISOString().split("T")[0],
                mode: {
                    paperTrading: env.paperTrading,
                    brokerProvider: env.brokerProvider,
                },
                summary: {
                    realizedPnL: Number(realizedPnL.toFixed(2)),
                    unrealizedPnL: Number(unrealizedPnL.toFixed(2)),
                    totalPnL: Number(totalPnL.toFixed(2)),
                    tradeCount: todaysTrades.length,
                },
                positions: positions.filter((p) => p.quantity !== 0),
                trades: todaysTrades.map((t) => ({
                    id: t.id,
                    symbol: t.symbol,
                    side: t.side,
                    quantity: t.quantity,
                    price: t.price,
                    executedAt: t.executedAt.toISOString(),
                    notes: t.notes,
                })),
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (error) {
        logger.error({ err: error }, "Failed to build paper P&L response");
        next(error);
    }
});

export default router;
