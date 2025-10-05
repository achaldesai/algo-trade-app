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

export class PortfolioService {
  private readonly stocks = new Map<string, Stock>();

  private readonly trades: Trade[] = [];

  private readonly lastTradeBySymbol = new Map<string, Trade>();

  constructor(initialStocks: CreateStockInput[] = [], initialTrades: CreateTradeInput[] = []) {
    initialStocks.forEach((stock) => {
      this.addStock(stock);
    });
    initialTrades.forEach((trade) => {
      this.addTrade(trade);
    });
  }

  public addStock(input: CreateStockInput): Stock {
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) {
      throw new HttpError(400, "Stock symbol is required");
    }

    if (this.stocks.has(symbol)) {
      throw new HttpError(409, `Stock with symbol ${symbol} already exists`);
    }

    const stock: Stock = {
      symbol,
      name: input.name.trim(),
      createdAt: new Date(),
    };

    this.stocks.set(symbol, stock);
    return stock;
  }

  public listStocks(): Stock[] {
    return Array.from(this.stocks.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  public addTrade(input: CreateTradeInput): Trade {
    const symbol = input.symbol.trim().toUpperCase();
    if (!this.stocks.has(symbol)) {
      throw new HttpError(404, `Unknown stock symbol ${symbol}`);
    }

    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new HttpError(400, "Trade quantity must be a positive number");
    }

    if (!Number.isFinite(input.price) || input.price <= 0) {
      throw new HttpError(400, "Trade price must be a positive number");
    }

    const trade: Trade = {
      id: randomUUID(),
      symbol,
      side: input.side,
      quantity: Math.round(input.quantity),
      price: input.price,
      executedAt: input.executedAt ?? new Date(),
      notes: input.notes?.trim() || undefined,
    };

    this.persistTrade(trade);
    return trade;
  }

  public listTrades(): Trade[] {
    return [...this.trades].sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime());
  }

  public recordExternalTrade(trade: Trade): void {
    const symbol = trade.symbol.trim().toUpperCase();
    if (!this.stocks.has(symbol)) {
      this.addStock({ symbol, name: symbol });
    }

    this.persistTrade({ ...trade, symbol });
  }

  public getSnapshot(): PortfolioSnapshot {
    const summaries = this.getTradeSummaries();

    const positions: PortfolioPositionSnapshot[] = summaries.map((summary) => {
      const markPrice = this.lastTradeBySymbol.get(summary.symbol)?.price ?? summary.averageEntryPrice;
      const unrealizedPnl = summary.netQuantity * (markPrice - summary.averageEntryPrice);
      return {
        ...summary,
        unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
      } satisfies PortfolioPositionSnapshot;
    });

    return {
      generatedAt: new Date(),
      positions,
      totalTrades: this.trades.length,
    } satisfies PortfolioSnapshot;
  }

  public getTradeSummaries(): TradeSummary[] {
    const states = new Map<string, PositionState>();

    const sortedTrades = [...this.trades].sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime());
    for (const trade of sortedTrades) {
      const state = states.get(trade.symbol) ?? { netQuantity: 0, totalCost: 0, realizedPnl: 0 };

      if (trade.side === "BUY") {
        state.totalCost += trade.price * trade.quantity;
        state.netQuantity += trade.quantity;
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
          // Transition to a short position: treat proceeds as negative cost basis.
          state.netQuantity -= residualQty;
          state.totalCost -= residualQty * trade.price;
        }
      }

      states.set(trade.symbol, state);
    }

    return Array.from(states.entries()).map(([symbol, state]) => {
      const stock = this.stocks.get(symbol);
      const position = state.netQuantity > 0 ? "LONG" : state.netQuantity < 0 ? "SHORT" : "FLAT";
      const averageEntryPrice = state.netQuantity !== 0 ? Math.abs(state.totalCost / state.netQuantity) : 0;

      return {
        symbol,
        name: stock?.name ?? symbol,
        netQuantity: state.netQuantity,
        averageEntryPrice: Number(averageEntryPrice.toFixed(4)),
        realizedPnl: Number(state.realizedPnl.toFixed(2)),
        position,
      } satisfies TradeSummary;
    });
  }

  private persistTrade(trade: Trade): void {
    this.trades.push(trade);
    this.trades.sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime());
    this.lastTradeBySymbol.set(trade.symbol, trade);
  }
}

export default PortfolioService;
