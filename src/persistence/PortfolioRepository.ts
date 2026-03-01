import type { Stock, Trade, TradeSide } from "../types";

export interface CreateStockRecord {
  symbol: string;
  name: string;
  createdAt: Date;
}

export interface CreateTradeRecord {
  id: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  executedAt: Date;
  notes?: string;
}

export interface PortfolioRepository {
  initialize(): Promise<void>;
  reset(): Promise<void>;
  listStocks(userId: string): Promise<Stock[]>;
  findStock(userId: string, symbol: string): Promise<Stock | undefined>;
  createStock(userId: string, record: CreateStockRecord): Promise<Stock>;
  ensureStock(userId: string, record: CreateStockRecord): Promise<Stock>;
  listTrades(userId: string): Promise<Trade[]>;
  createTrade(userId: string, record: CreateTradeRecord): Promise<Trade>;
  createTradeIfMissing(userId: string, record: CreateTradeRecord): Promise<boolean>;
}

export default PortfolioRepository;
