import { promises as fs } from "node:fs";
import path from "node:path";
import { open, type Database } from "lmdb";
import type { Stock, Trade, TradeSide } from "../types";
import { seedStocks, seedTrades } from "../data/seed";
import type {
  CreateStockRecord,
  CreateTradeRecord,
  PortfolioRepository,
} from "./PortfolioRepository";
import { RepositoryConflictError } from "./errors";
import { deterministicTradeId } from "./storeUtils";

interface StockRecordData {
  symbol: string;
  name: string;
  createdAt: string;
}

interface TradeRecordData {
  id: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  executedAt: string;
  notes?: string;
}

export class LmdbPortfolioRepository implements PortfolioRepository {
  private stocksDb: Database<StockRecordData> | null = null;

  private tradesDb: Database<TradeRecordData> | null = null;

  constructor(private readonly storePath: string) {}

  /**
   * Creates a timestamped backup of the LMDB database
   * Keeps only the last 7 backups to prevent disk space issues
   * @returns Path to the created backup directory
   */
  async createBackup(): Promise<string> {
    // Include milliseconds and add random suffix to ensure unique backup names
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const backupDir = path.join(path.dirname(this.storePath), 'backups');
    const backupPath = path.join(backupDir, `portfolio-${timestamp}-${randomSuffix}`);

    // Ensure backup directory exists
    await fs.mkdir(backupDir, { recursive: true });

    // Copy entire LMDB directory (includes data.mdb and lock.mdb)
    await fs.cp(this.storePath, backupPath, { recursive: true });

    // Clean up old backups (keep only last 7)
    await this.cleanupOldBackups(backupDir, 7);

    return backupPath;
  }

  /**
   * Restores the database from a backup
   * @param backupPath Path to the backup directory
   */
  async restoreFromBackup(backupPath: string): Promise<void> {
    // Verify backup exists
    try {
      await fs.access(backupPath);
    } catch {
      throw new Error(`Backup not found: ${backupPath}`);
    }

    // Close current databases
    if (this.stocksDb) {
      this.stocksDb.close();
      this.stocksDb = null;
    }
    if (this.tradesDb) {
      this.tradesDb.close();
      this.tradesDb = null;
    }

    // Remove current database
    await fs.rm(this.storePath, { recursive: true, force: true });

    // Copy backup to current location
    await fs.cp(backupPath, this.storePath, { recursive: true });

    // Reinitialize databases
    await this.initialize();
  }

  /**
   * Lists all available backups
   * @returns Array of backup paths sorted by date (newest first)
   */
  async listBackups(): Promise<string[]> {
    const backupDir = path.join(path.dirname(this.storePath), 'backups');

    try {
      const entries = await fs.readdir(backupDir);
      const backups = entries
        .filter(name => name.startsWith('portfolio-'))
        .sort()
        .reverse(); // Newest first

      return backups.map(name => path.join(backupDir, name));
    } catch {
      return []; // No backups directory yet
    }
  }

  /**
   * Exports database contents to JSON format for human inspection
   * @returns JSON object with all stocks and trades
   */
  async exportToJson(): Promise<{ stocks: Stock[]; trades: Trade[]; exportedAt: string }> {
    const stocks = await this.listStocks();
    const trades = await this.listTrades();

    return {
      stocks,
      trades,
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * Gets database statistics including backup information
   */
  async getStats(): Promise<{
    path: string;
    sizeMB: number;
    stockCount: number;
    tradeCount: number;
    backupCount: number;
    lastBackup: string | null;
  }> {
    const dataFilePath = path.join(this.storePath, 'data.mdb');

    try {
      const stats = await fs.stat(dataFilePath);
      const stocks = await this.listStocks();
      const trades = await this.listTrades();
      const backups = await this.listBackups();

      return {
        path: this.storePath,
        sizeMB: Math.round((stats.size / 1024 / 1024) * 100) / 100,
        stockCount: stocks.length,
        tradeCount: trades.length,
        backupCount: backups.length,
        lastBackup: backups.length > 0 ? path.basename(backups[0]) : null,
      };
    } catch {
      return {
        path: this.storePath,
        sizeMB: 0,
        stockCount: 0,
        tradeCount: 0,
        backupCount: 0,
        lastBackup: null,
      };
    }
  }

  private async cleanupOldBackups(backupDir: string, keepCount: number): Promise<void> {
    try {
      const entries = await fs.readdir(backupDir);
      const backups = entries
        .filter(name => name.startsWith('portfolio-'))
        .sort();

      // Remove oldest backups if we exceed keepCount
      if (backups.length > keepCount) {
        const toRemove = backups.slice(0, backups.length - keepCount);
        for (const backup of toRemove) {
          await fs.rm(path.join(backupDir, backup), { recursive: true });
        }
      }
    } catch {
      // Ignore errors in cleanup
    }
  }

  async initialize(): Promise<void> {
    if (this.stocksDb && this.tradesDb) {
      return;
    }

    const directory = path.dirname(this.storePath);
    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(this.storePath, { recursive: true });

    const root = open<unknown>({
      path: this.storePath,
      compression: true,
    });

    const stocksDb = root.openDB<StockRecordData>({
      name: "stocks",
      encoding: "json",
    });
    const tradesDb = root.openDB<TradeRecordData>({
      name: "trades",
      encoding: "json",
    });

    this.stocksDb = stocksDb;
    this.tradesDb = tradesDb;

    if (this.shouldSeed()) {
      await this.seed();
    }
  }

  async reset(): Promise<void> {
    await this.seed();
  }

  async listStocks(): Promise<Stock[]> {
    const stocksDb = this.ensureStocksDb();
    const stocks: Stock[] = [];

    for (const { value } of stocksDb.getRange()) {
      stocks.push(this.toStock(value));
    }

    return stocks.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  async findStock(symbol: string): Promise<Stock | undefined> {
    const stocksDb = this.ensureStocksDb();
    const record = stocksDb.get(symbol.toUpperCase());
    return record ? this.toStock(record) : undefined;
  }

  async createStock(record: CreateStockRecord): Promise<Stock> {
    const stocksDb = this.ensureStocksDb();
    const symbol = record.symbol.toUpperCase();
    const existing = stocksDb.get(symbol);
    if (existing) {
      throw new RepositoryConflictError(`Stock ${symbol} already exists`);
    }

    const entry: StockRecordData = {
      symbol,
      name: record.name,
      createdAt: record.createdAt.toISOString(),
    };

    await stocksDb.put(symbol, entry);
    return this.toStock(entry);
  }

  async ensureStock(record: CreateStockRecord): Promise<Stock> {
    const existing = await this.findStock(record.symbol);
    if (existing) {
      return existing;
    }
    return this.createStock(record);
  }

  async listTrades(): Promise<Trade[]> {
    const tradesDb = this.ensureTradesDb();
    const trades: Trade[] = [];

    for (const { value } of tradesDb.getRange()) {
      trades.push(this.toTrade(value));
    }

    return trades.sort((a, b) => {
      const diff = a.executedAt.getTime() - b.executedAt.getTime();
      if (diff !== 0) {
        return diff;
      }
      return a.id.localeCompare(b.id);
    });
  }

  async createTrade(record: CreateTradeRecord): Promise<Trade> {
    const tradesDb = this.ensureTradesDb();
    const existing = tradesDb.get(record.id);
    if (existing) {
      throw new RepositoryConflictError(`Trade ${record.id} already exists`);
    }

    const entry: TradeRecordData = this.toTradeRecord(record);
    await tradesDb.put(entry.id, entry);
    return this.toTrade(entry);
  }

  async createTradeIfMissing(record: CreateTradeRecord): Promise<boolean> {
    const tradesDb = this.ensureTradesDb();
    const existing = tradesDb.get(record.id);
    if (existing) {
      return false;
    }

    const entry: TradeRecordData = this.toTradeRecord(record);
    await tradesDb.put(entry.id, entry);
    return true;
  }

  private ensureStocksDb(): Database<StockRecordData> {
    if (!this.stocksDb) {
      throw new Error("Stocks database is not initialised");
    }
    return this.stocksDb;
  }

  private ensureTradesDb(): Database<TradeRecordData> {
    if (!this.tradesDb) {
      throw new Error("Trades database is not initialised");
    }
    return this.tradesDb;
  }

  private shouldSeed(): boolean {
    const stocksDb = this.ensureStocksDb();
    const iterator = stocksDb.getRange({ limit: 1 })[Symbol.iterator]();
    const first = iterator.next();
    return Boolean(first.done);
  }

  private async seed(): Promise<void> {
    const stocksDb = this.ensureStocksDb();
    const tradesDb = this.ensureTradesDb();

    const seededStocks: StockRecordData[] = seedStocks.map((stock) => ({
      symbol: stock.symbol.toUpperCase(),
      name: stock.name.trim(),
      createdAt: new Date().toISOString(),
    }));

    const seededTrades: TradeRecordData[] = seedTrades.map((trade) => ({
      id: deterministicTradeId({
        symbol: trade.symbol.toUpperCase(),
        side: trade.side,
        quantity: trade.quantity,
        price: trade.price,
        executedAt: trade.executedAt ?? new Date(),
        notes: trade.notes,
      }),
      symbol: trade.symbol.toUpperCase(),
      side: trade.side,
      quantity: Math.round(trade.quantity),
      price: trade.price,
      executedAt: (trade.executedAt ?? new Date()).toISOString(),
      notes: trade.notes,
    }));

    stocksDb.clearSync();
    tradesDb.clearSync();

    for (const entry of seededStocks) {
      await stocksDb.put(entry.symbol, entry);
    }

    const sortedTrades = seededTrades
      .sort((a, b) => new Date(a.executedAt).getTime() - new Date(b.executedAt).getTime());

    for (const entry of sortedTrades) {
      await tradesDb.put(entry.id, entry);
    }
  }

  private toStock(record: StockRecordData): Stock {
    return {
      symbol: record.symbol,
      name: record.name,
      createdAt: new Date(record.createdAt),
    };
  }

  private toTrade(record: TradeRecordData): Trade {
    return {
      id: record.id,
      symbol: record.symbol,
      side: record.side,
      quantity: record.quantity,
      price: record.price,
      executedAt: new Date(record.executedAt),
      notes: record.notes,
    };
  }

  private toTradeRecord(record: CreateTradeRecord): TradeRecordData {
    return {
      id: record.id,
      symbol: record.symbol.toUpperCase(),
      side: record.side,
      quantity: Math.round(record.quantity),
      price: Number(record.price),
      executedAt: record.executedAt.toISOString(),
      notes: record.notes,
    };
  }
}

export default LmdbPortfolioRepository;
