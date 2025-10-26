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
  listStocks(): Promise<Stock[]>;
  findStock(symbol: string): Promise<Stock | undefined>;
  createStock(record: CreateStockRecord): Promise<Stock>;
  ensureStock(record: CreateStockRecord): Promise<Stock>;
  listTrades(): Promise<Trade[]>;
  createTrade(record: CreateTradeRecord): Promise<Trade>;
  createTradeIfMissing(record: CreateTradeRecord): Promise<boolean>;
}

export default PortfolioRepository;
