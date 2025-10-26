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
import type {
  CreateStockRecord,
  CreateTradeRecord,
  PortfolioRepository,
} from "../persistence/PortfolioRepository";
import { RepositoryConflictError } from "../persistence/errors";

export interface CreateStockInput {
  symbol: string;
  name: string;
}

export interface CreateTradeInput {
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  executedAt?: Date;
  notes?: string;
}

interface PositionState {
  netQuantity: number;
  totalCost: number;
  realizedPnl: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PortfolioService {
  constructor(private readonly repository: PortfolioRepository) {}

  public async addStock(input: CreateStockInput): Promise<Stock> {
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) {
      throw new HttpError(400, "Stock symbol is required");
    }

    const name = input.name.trim();
    if (!name) {
      throw new HttpError(400, "Stock name is required");
    }

    const record: CreateStockRecord = {
      symbol,
      name,
      createdAt: new Date(),
    };

    try {
      return await this.repository.createStock(record);
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        throw new HttpError(409, `Stock with symbol ${symbol} already exists`);
      }
      throw error;
    }
  }

  public async listStocks(): Promise<Stock[]> {
    return this.repository.listStocks();
  }

  public async addTrade(input: CreateTradeInput): Promise<Trade> {
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) {
      throw new HttpError(400, "Trade symbol is required");
    }

    const stock = await this.repository.findStock(symbol);
    if (!stock) {
      throw new HttpError(404, `Unknown stock symbol ${symbol}`);
    }

    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new HttpError(400, "Trade quantity must be a positive number");
    }

    if (!Number.isFinite(input.price) || input.price <= 0) {
      throw new HttpError(400, "Trade price must be a positive number");
    }

    const record: CreateTradeRecord = {
      id: randomUUID(),
      symbol,
      side: input.side,
      quantity: Math.round(input.quantity),
      price: Number(input.price),
      executedAt: input.executedAt ?? new Date(),
      notes: input.notes?.trim() || undefined,
    };

    return this.repository.createTrade(record);
  }

  public async listTrades(): Promise<Trade[]> {
    const trades = await this.repository.listTrades();
    return [...trades].sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime());
  }

  public async recordExternalTrade(trade: Trade): Promise<void> {
    const symbol = trade.symbol.trim().toUpperCase();
    if (!symbol) {
      throw new HttpError(400, "Trade symbol is required");
    }

    await this.repository.ensureStock({ symbol, name: symbol, createdAt: new Date() });

    const id = UUID_PATTERN.test(trade.id) ? trade.id : randomUUID();

    await this.repository.createTradeIfMissing({
      id,
      symbol,
      side: trade.side,
      quantity: Math.round(trade.quantity),
      price: Number(trade.price),
      executedAt: trade.executedAt,
      notes: trade.notes,
    });
  }

  public async getSnapshot(): Promise<PortfolioSnapshot> {
    const trades = await this.repository.listTrades();
    const [summaries, latestPrices] = await Promise.all([
      this.getTradeSummaries(trades),
      this.getLatestTradePrices(trades),
    ]);

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

  public async getTradeSummaries(tradesOverride?: Trade[]): Promise<TradeSummary[]> {
    const trades = tradesOverride ?? (await this.repository.listTrades());
    const stocks = await this.repository.listStocks();
    const stockMap = new Map(stocks.map((stock) => [stock.symbol, stock.name]));

    const states = new Map<string, PositionState>();

    for (const trade of trades) {
      const state = states.get(trade.symbol) ?? { netQuantity: 0, totalCost: 0, realizedPnl: 0 };

      if (trade.side === "BUY") {
        let remainingQuantity = trade.quantity;

        const openShortQuantity = Math.max(-state.netQuantity, 0);
        if (openShortQuantity > 0) {
          const closingQuantity = Math.min(openShortQuantity, remainingQuantity);
          if (closingQuantity > 0) {
            const entryAverage = state.netQuantity !== 0 ? state.totalCost / state.netQuantity : 0;
            state.realizedPnl += closingQuantity * (entryAverage - trade.price);
            state.netQuantity += closingQuantity;
            state.totalCost += entryAverage * closingQuantity;
            remainingQuantity -= closingQuantity;

            if (state.netQuantity === 0) {
              state.totalCost = 0;
            }
          }
        }

        if (remainingQuantity > 0) {
          state.totalCost += trade.price * remainingQuantity;
          state.netQuantity += remainingQuantity;
        }
      } else {
        const closingQty = Math.min(Math.max(state.netQuantity, 0), trade.quantity);
        const avgCost = state.netQuantity > 0 ? state.totalCost / state.netQuantity : 0;
        if (closingQty > 0) {
          state.realizedPnl += closingQty * (trade.price - avgCost);
          state.totalCost -= closingQty * avgCost;
          state.netQuantity -= closingQty;
        }

        const residualQty = trade.quantity - closingQty;
        if (residualQty > 0) {
          state.netQuantity -= residualQty;
          state.totalCost -= residualQty * trade.price;
        }
      }

      if (state.netQuantity === 0) {
        state.totalCost = 0;
      }

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

  private async getLatestTradePrices(tradesOverride?: Trade[]): Promise<Map<string, number>> {
    const trades = tradesOverride ?? (await this.repository.listTrades());
    const latest = new Map<string, number>();

    for (let index = trades.length - 1; index >= 0; index -= 1) {
      const trade = trades[index];
      if (!latest.has(trade.symbol)) {
        latest.set(trade.symbol, trade.price);
      }
    }

    return latest;
  }
}

export default PortfolioService;
