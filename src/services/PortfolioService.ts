import { randomUUID } from "crypto";
import { HttpError } from "../utils/HttpError";
import type {
  PortfolioPositionSnapshot,
  PortfolioSnapshot,
  Stock,
  Trade,
  TradeSide,
  TradeSummary,
} from "../types";
import type { PortfolioRepo, CreateTradeInput } from "../db/repositories/PortfolioRepo";
import { RepositoryConflictError } from "../db/repositories/errors";

// ─── Input Types ─────────────────────────────────────────────────────────────

export interface CreateStockInput {
  symbol: string;
  name: string;
}

export interface CreateTradeInputPublic {
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  executedAt?: Date;
  notes?: string;
}

// ─── Position State Machine ──────────────────────────────────────────────────

interface PositionState {
  netQuantity: number;
  totalCost: number;
  realizedPnl: number;
}

/**
 * Single source of truth for position/P&L calculation.
 * Used by both getTradeSummaries() and getRealizedPnl().
 */
function processTradeIntoPosition(state: PositionState, trade: Trade): { pnl: number } {
  let tradePnl = 0;

  if (trade.side === "BUY") {
    let remainingQuantity = trade.quantity;

    // Cover short positions first
    const openShort = Math.max(-state.netQuantity, 0);
    if (openShort > 0) {
      const closingQty = Math.min(openShort, remainingQuantity);
      if (closingQty > 0) {
        const entryAvg = state.netQuantity !== 0 ? state.totalCost / state.netQuantity : 0;
        const pnl = closingQty * (entryAvg - trade.price);
        state.realizedPnl += pnl;
        tradePnl += pnl;

        state.netQuantity += closingQty;
        state.totalCost += entryAvg * closingQty;
        remainingQuantity -= closingQty;

        if (state.netQuantity === 0) state.totalCost = 0;
      }
    }

    // Add to long
    if (remainingQuantity > 0) {
      state.totalCost += trade.price * remainingQuantity;
      state.netQuantity += remainingQuantity;
    }
  } else {
    // SELL
    const closingQty = Math.min(Math.max(state.netQuantity, 0), trade.quantity);
    const avgCost = state.netQuantity > 0 ? state.totalCost / state.netQuantity : 0;

    if (closingQty > 0) {
      const pnl = closingQty * (trade.price - avgCost);
      state.realizedPnl += pnl;
      tradePnl += pnl;

      state.totalCost -= closingQty * avgCost;
      state.netQuantity -= closingQty;
    }

    // Remaining sells become short positions
    const residualQty = trade.quantity - closingQty;
    if (residualQty > 0) {
      state.netQuantity -= residualQty;
      state.totalCost -= residualQty * trade.price;
    }
  }

  if (state.netQuantity === 0) state.totalCost = 0;

  return { pnl: tradePnl };
}

// ─── Service ─────────────────────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PortfolioService {
  constructor(private readonly repo: PortfolioRepo) { }

  public async addStock(userId: string, input: CreateStockInput): Promise<Stock> {
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) throw new HttpError(400, "Stock symbol is required");

    const name = input.name.trim();
    if (!name) throw new HttpError(400, "Stock name is required");

    try {
      return await this.repo.createStock(userId, {
        symbol,
        name,
        createdAt: new Date(),
      });
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        throw new HttpError(409, `Stock with symbol ${symbol} already exists`);
      }
      throw error;
    }
  }

  public listStocks(userId: string): Stock[] {
    return this.repo.listStocks(userId);
  }

  public async addTrade(userId: string, input: CreateTradeInputPublic): Promise<Trade> {
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) throw new HttpError(400, "Trade symbol is required");

    const stock = this.repo.findStock(userId, symbol);
    if (!stock) throw new HttpError(404, `Unknown stock symbol ${symbol}`);

    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new HttpError(400, "Trade quantity must be a positive number");
    }

    if (!Number.isFinite(input.price) || input.price <= 0) {
      throw new HttpError(400, "Trade price must be a positive number");
    }

    const record: CreateTradeInput = {
      id: randomUUID(),
      symbol,
      side: input.side,
      quantity: Math.round(input.quantity),
      price: Number(input.price),
      executedAt: input.executedAt ?? new Date(),
      notes: input.notes?.trim() || undefined,
    };

    return this.repo.createTrade(userId, record);
  }

  public listTrades(userId: string): Trade[] {
    const trades = this.repo.listTrades(userId);
    return [...trades].sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime());
  }

  /**
   * Record a trade from an external source (broker execution, reconciliation).
   * Atomically ensures the stock exists and creates the trade.
   */
  public async recordExternalTrade(userId: string, trade: Trade): Promise<void> {
    const symbol = trade.symbol.trim().toUpperCase();
    if (!symbol) throw new HttpError(400, "Trade symbol is required");

    const id = UUID_PATTERN.test(trade.id) ? trade.id : randomUUID();

    await this.repo.recordTradeAtomic(
      userId,
      { symbol, name: symbol, createdAt: new Date() },
      {
        id,
        symbol,
        side: trade.side,
        quantity: Math.round(trade.quantity),
        price: Number(trade.price),
        executedAt: trade.executedAt,
        notes: trade.notes,
      }
    );
  }

  public getSnapshot(userId: string): PortfolioSnapshot {
    const trades = this.repo.listTrades(userId);
    const summaries = this.getTradeSummaries(userId, trades);
    const latestPrices = this.getLatestTradePrices(trades);

    const positions: PortfolioPositionSnapshot[] = summaries.map((summary) => {
      const markPrice = latestPrices.get(summary.symbol) ?? summary.averageEntryPrice;
      const unrealizedPnl = summary.netQuantity * (markPrice - summary.averageEntryPrice);
      return {
        ...summary,
        unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
      } satisfies PortfolioPositionSnapshot;
    });

    return {
      generatedAt: new Date(),
      positions,
      totalTrades: trades.length,
    } satisfies PortfolioSnapshot;
  }

  public getTradeSummaries(userId: string, tradesOverride?: Trade[]): TradeSummary[] {
    const trades = tradesOverride ?? this.repo.listTrades(userId);
    const stocks = this.repo.listStocks(userId);
    const stockMap = new Map(stocks.map((stock) => [stock.symbol, stock.name]));

    const states = new Map<string, PositionState>();

    for (const trade of trades) {
      const state = states.get(trade.symbol) ?? { netQuantity: 0, totalCost: 0, realizedPnl: 0 };
      processTradeIntoPosition(state, trade);
      states.set(trade.symbol, state);
    }

    return Array.from(states.entries()).map(([symbol, state]) => {
      const position = state.netQuantity > 0 ? "LONG" : state.netQuantity < 0 ? "SHORT" : "FLAT";
      const averageEntryPrice = state.netQuantity !== 0 ? Math.abs(state.totalCost / state.netQuantity) : 0;

      return {
        symbol,
        name: stockMap.get(symbol) ?? symbol,
        netQuantity: state.netQuantity,
        averageEntryPrice: Number(averageEntryPrice.toFixed(4)),
        realizedPnl: Number(state.realizedPnl.toFixed(2)),
        position,
      } satisfies TradeSummary;
    });
  }

  private getLatestTradePrices(trades: Trade[]): Map<string, number> {
    const latest = new Map<string, number>();

    for (let index = trades.length - 1; index >= 0; index -= 1) {
      const trade = trades[index];
      if (!latest.has(trade.symbol)) {
        latest.set(trade.symbol, trade.price);
      }
    }

    return latest;
  }

  /**
   * Calculate realized P&L for a specific time period.
   * Uses the same position state machine as getTradeSummaries().
   */
  public getRealizedPnl(userId: string, fromDate?: Date): number {
    const trades = this.repo.listTrades(userId);
    // Trades are already sorted chronologically from the repo

    const states = new Map<string, PositionState>();
    let totalRealizedPnl = 0;

    for (const trade of trades) {
      const state = states.get(trade.symbol) ?? { netQuantity: 0, totalCost: 0, realizedPnl: 0 };
      const { pnl } = processTradeIntoPosition(state, trade);
      states.set(trade.symbol, state);

      if (!fromDate || trade.executedAt >= fromDate) {
        totalRealizedPnl += pnl;
      }
    }

    return Number(totalRealizedPnl.toFixed(2));
  }
}

export default PortfolioService;
