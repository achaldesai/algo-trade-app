import { Router } from "express";
import { getContainer } from "../util/getContainer";
import { userAuthMiddleware } from "../middleware/userAuth";
import env from "../config/env";
import type { Trade, TradeSummary, PortfolioPositionSnapshot } from "../types";

const router = Router();
router.use(userAuthMiddleware);

const CACHE_TTL_MS = 5000;
let dailyPnLCache: { data: unknown; timestamp: number } | null = null;

router.get("/daily", async (req, res, next) => {
    try {
        if (dailyPnLCache && (Date.now() - dailyPnLCache.timestamp < CACHE_TTL_MS)) {
            res.json(dailyPnLCache.data);
            return;
        }

        const { portfolioService, marketDataService, riskManager } = getContainer(req);
        const userId = req.user!.userId;

        const allTrades = portfolioService.listTrades(userId);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayEnd = new Date(today);
        todayEnd.setHours(23, 59, 59, 999);

        const todaysTrades = allTrades.filter((trade: Trade) => {
            const tradeDate = new Date(trade.executedAt);
            return tradeDate >= today && tradeDate <= todayEnd;
        });

        const dailyRealizedPnL = portfolioService.getRealizedPnl(userId, today);

        const snapshot = portfolioService.getSnapshot(userId);

        let totalUnrealizedPnL = 0;
        const positionsWithLivePrices = snapshot.positions.map((pos: PortfolioPositionSnapshot) => {
            const liveTick = marketDataService.getTick(pos.symbol);
            let unrealizedPnl = pos.unrealizedPnl;
            let currentPrice = pos.averageEntryPrice;

            if (liveTick && pos.netQuantity !== 0) {
                currentPrice = liveTick.price;
                unrealizedPnl = pos.netQuantity * (liveTick.price - pos.averageEntryPrice);
                unrealizedPnl = Number(unrealizedPnl.toFixed(2));
            }

            totalUnrealizedPnL += unrealizedPnl;

            return {
                symbol: pos.symbol,
                quantity: pos.netQuantity,
                entryPrice: pos.averageEntryPrice,
                currentPrice,
                unrealizedPnl,
                realizedPnl: pos.realizedPnl,
                position: pos.position,
            };
        });

        const riskStatus = riskManager.getStatus(userId);
        const totalPnL = dailyRealizedPnL + totalUnrealizedPnL;

        const responseData = {
            success: true,
            data: {
                date: today.toISOString().split('T')[0],
                mode: {
                    paperTrading: env.paperTrading,
                    brokerProvider: env.brokerProvider,
                },
                summary: {
                    realizedPnL: Number(dailyRealizedPnL.toFixed(2)),
                    unrealizedPnL: Number(totalUnrealizedPnL.toFixed(2)),
                    totalPnL: Number(totalPnL.toFixed(2)),
                    tradeCount: todaysTrades.length,
                    circuitBroken: riskStatus.circuitBroken,
                },
                positions: positionsWithLivePrices.filter((p: { quantity: number }) => p.quantity !== 0),
                trades: todaysTrades.map((t: Trade) => ({
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
        };

        dailyPnLCache = { data: responseData, timestamp: Date.now() };
        res.json(responseData);
    } catch (error) {
        next(error);
    }
});

router.get("/summary", async (req, res, next) => {
    try {
        const { portfolioService, marketDataService } = getContainer(req);
        const userId = req.user!.userId;

        const snapshot = portfolioService.getSnapshot(userId);

        let totalRealizedPnL = 0;
        let totalUnrealizedPnL = 0;

        const positions = snapshot.positions.map((pos: PortfolioPositionSnapshot) => {
            const liveTick = marketDataService.getTick(pos.symbol);
            let unrealizedPnl = pos.unrealizedPnl;
            let currentPrice = pos.averageEntryPrice;

            if (liveTick && pos.netQuantity !== 0) {
                currentPrice = liveTick.price;
                unrealizedPnl = pos.netQuantity * (liveTick.price - pos.averageEntryPrice);
                unrealizedPnl = Number(unrealizedPnl.toFixed(2));
            }

            totalRealizedPnL += pos.realizedPnl;
            totalUnrealizedPnL += unrealizedPnl;

            return {
                symbol: pos.symbol,
                name: pos.name,
                quantity: pos.netQuantity,
                entryPrice: pos.averageEntryPrice,
                currentPrice,
                realizedPnl: pos.realizedPnl,
                unrealizedPnl,
                position: pos.position,
            };
        });

        res.json({
            success: true,
            data: {
                totalRealizedPnL: Number(totalRealizedPnL.toFixed(2)),
                totalUnrealizedPnL: Number(totalUnrealizedPnL.toFixed(2)),
                totalPnL: Number((totalRealizedPnL + totalUnrealizedPnL).toFixed(2)),
                totalTrades: snapshot.totalTrades,
                openPositions: positions.filter((p: { quantity: number }) => p.quantity !== 0).length,
                positions,
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (error) {
        next(error);
    }
});

router.get("/positions", async (req, res, next) => {
    try {
        const { portfolioService, marketDataService } = getContainer(req);
        const userId = req.user!.userId;
        const summaries = portfolioService.getTradeSummaries(userId);

        const positions = summaries
            .filter((s: TradeSummary) => s.netQuantity !== 0)
            .map((pos: TradeSummary) => {
                const liveTick = marketDataService.getTick(pos.symbol);
                const currentPrice = liveTick?.price ?? pos.averageEntryPrice;
                const unrealizedPnl = pos.netQuantity * (currentPrice - pos.averageEntryPrice);
                const marketValue = pos.netQuantity * currentPrice;
                const costBasis = pos.netQuantity * pos.averageEntryPrice;

                return {
                    symbol: pos.symbol,
                    name: pos.name,
                    quantity: pos.netQuantity,
                    entryPrice: pos.averageEntryPrice,
                    currentPrice,
                    marketValue: Number(marketValue.toFixed(2)),
                    costBasis: Number(costBasis.toFixed(2)),
                    unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
                    unrealizedPnlPercent: pos.averageEntryPrice > 0
                        ? Number(((currentPrice - pos.averageEntryPrice) / pos.averageEntryPrice * 100).toFixed(2))
                        : 0,
                    realizedPnl: pos.realizedPnl,
                    position: pos.position,
                    hasLivePrice: !!liveTick,
                };
            });

        const totalMarketValue = positions.reduce((sum: number, p: { marketValue: number }) => sum + p.marketValue, 0);
        const totalUnrealizedPnL = positions.reduce((sum: number, p: { unrealizedPnl: number }) => sum + p.unrealizedPnl, 0);

        res.json({
            success: true,
            data: {
                positions,
                totals: {
                    marketValue: Number(totalMarketValue.toFixed(2)),
                    unrealizedPnL: Number(totalUnrealizedPnL.toFixed(2)),
                    positionCount: positions.length,
                },
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (error) {
        next(error);
    }
});

export default router;
