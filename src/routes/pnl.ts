import { Router } from "express";
import { resolvePortfolioService, resolveMarketDataService, resolveRiskManager } from "../container";
import type { Trade } from "../types";

const router = Router();

/**
 * GET /api/pnl/daily
 * Get today's P&L summary
 */
const CACHE_TTL_MS = 5000;
let dailyPnLCache: {
    data: any;
    timestamp: number;
} | null = null;

/**
 * GET /api/pnl/daily
 * Get today's P&L summary
 */
router.get("/daily", async (_req, res, next) => {
    try {
        // Check cache
        if (dailyPnLCache && (Date.now() - dailyPnLCache.timestamp < CACHE_TTL_MS)) {
            return res.json(dailyPnLCache.data);
        }

        const portfolioService = resolvePortfolioService();
        const marketDataService = resolveMarketDataService();
        const riskManager = resolveRiskManager();

        // Get all trades
        const allTrades = await portfolioService.listTrades();

        // Filter to today's trades
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayEnd = new Date(today);
        todayEnd.setHours(23, 59, 59, 999);

        const todaysTrades = allTrades.filter(trade => {
            const tradeDate = new Date(trade.executedAt);
            return tradeDate >= today && tradeDate <= todayEnd;
        });

        // Calculate daily realized P&L from today's trades
        const dailyRealizedPnL = calculateDailyRealizedPnL(todaysTrades, allTrades);

        // Get current positions for unrealized P&L
        const snapshot = await portfolioService.getSnapshot();

        // Update unrealized P&L with live market prices if available
        let totalUnrealizedPnL = 0;
        const positionsWithLivePrices = snapshot.positions.map(pos => {
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

        // Risk manager status
        const riskStatus = riskManager.getStatus();

        const totalPnL = dailyRealizedPnL + totalUnrealizedPnL;

        const responseData = {
            success: true,
            data: {
                date: today.toISOString().split('T')[0],
                summary: {
                    realizedPnL: Number(dailyRealizedPnL.toFixed(2)),
                    unrealizedPnL: Number(totalUnrealizedPnL.toFixed(2)),
                    totalPnL: Number(totalPnL.toFixed(2)),
                    tradeCount: todaysTrades.length,
                    circuitBroken: riskStatus.circuitBroken,
                },
                positions: positionsWithLivePrices.filter(p => p.quantity !== 0),
                trades: todaysTrades.map(t => ({
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

        // Update cache
        dailyPnLCache = {
            data: responseData,
            timestamp: Date.now()
        };

        return res.json(responseData);
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/pnl/summary
 * Get overall P&L summary (all time)
 */
router.get("/summary", async (_req, res, next) => {
    try {
        const portfolioService = resolvePortfolioService();
        const marketDataService = resolveMarketDataService();

        const snapshot = await portfolioService.getSnapshot();

        let totalRealizedPnL = 0;
        let totalUnrealizedPnL = 0;

        const positions = snapshot.positions.map(pos => {
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
                openPositions: positions.filter(p => p.quantity !== 0).length,
                positions,
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/pnl/positions
 * Get current positions with live prices
 */
router.get("/positions", async (_req, res, next) => {
    try {
        const portfolioService = resolvePortfolioService();
        const marketDataService = resolveMarketDataService();
        const summaries = await portfolioService.getTradeSummaries();

        const positions = summaries
            .filter(s => s.netQuantity !== 0)
            .map(pos => {
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

        const totalMarketValue = positions.reduce((sum, p) => sum + p.marketValue, 0);
        const totalUnrealizedPnL = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

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

/**
 * Calculate realized P&L from today's closing trades
 */
function calculateDailyRealizedPnL(todaysTrades: Trade[], allTrades: Trade[]): number {
    // Build position state from all trades BEFORE today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const positionStates = new Map<string, { avgCost: number; quantity: number }>();

    // Process all historical trades to get opening positions
    for (const trade of allTrades) {
        if (new Date(trade.executedAt) >= today) continue;

        const state = positionStates.get(trade.symbol) ?? { avgCost: 0, quantity: 0 };

        if (trade.side === "BUY") {
            if (state.quantity >= 0) {
                // Adding to long position
                const newCost = (state.avgCost * state.quantity) + (trade.price * trade.quantity);
                state.quantity += trade.quantity;
                state.avgCost = state.quantity > 0 ? newCost / state.quantity : 0;
            } else {
                // Covering short
                state.quantity += trade.quantity;
                if (state.quantity >= 0) {
                    state.avgCost = trade.price; // Reset if we flip to long
                }
            }
        } else {
            if (state.quantity > 0) {
                // Closing long
                state.quantity -= trade.quantity;
            } else {
                // Adding to short
                const newCost = (state.avgCost * Math.abs(state.quantity)) + (trade.price * trade.quantity);
                state.quantity -= trade.quantity;
                state.avgCost = state.quantity !== 0 ? newCost / Math.abs(state.quantity) : 0;
            }
        }

        positionStates.set(trade.symbol, state);
    }

    // Now calculate realized P&L from today's trades
    let dailyRealizedPnL = 0;

    for (const trade of todaysTrades) {
        const state = positionStates.get(trade.symbol) ?? { avgCost: 0, quantity: 0 };

        if (trade.side === "SELL" && state.quantity > 0) {
            // Closing long position
            const closingQty = Math.min(state.quantity, trade.quantity);
            dailyRealizedPnL += closingQty * (trade.price - state.avgCost);
            state.quantity -= closingQty;
        } else if (trade.side === "BUY" && state.quantity < 0) {
            // Covering short position
            const coveringQty = Math.min(Math.abs(state.quantity), trade.quantity);
            dailyRealizedPnL += coveringQty * (state.avgCost - trade.price);
            state.quantity += coveringQty;
        } else if (trade.side === "BUY") {
            // Opening or adding to long
            const newCost = (state.avgCost * state.quantity) + (trade.price * trade.quantity);
            state.quantity += trade.quantity;
            state.avgCost = state.quantity > 0 ? newCost / state.quantity : 0;
        } else {
            // Opening or adding to short
            const newCost = (state.avgCost * Math.abs(state.quantity)) + (trade.price * trade.quantity);
            state.quantity -= trade.quantity;
            state.avgCost = state.quantity !== 0 ? newCost / Math.abs(state.quantity) : 0;
        }

        positionStates.set(trade.symbol, state);
    }

    return dailyRealizedPnL;
}

export default router;
