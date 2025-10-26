import { promises as fs } from "node:fs";
import path from "node:path";
import type { Stock, Trade } from "../types";
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
  side: Trade["side"];
  quantity: number;
  price: number;
  executedAt: string;
  notes?: string;
}

interface PortfolioStoreData {
  version: number;
  stocks: StockRecordData[];
  trades: TradeRecordData[];
}

const CURRENT_VERSION = 1;

const ensureDirectory = async (filePath: string): Promise<void> => {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
};

const toStock = (record: StockRecordData): Stock => ({
  symbol: record.symbol,
  name: record.name,
  createdAt: new Date(record.createdAt),
});

const toTrade = (record: TradeRecordData): Trade => ({
  id: record.id,
  symbol: record.symbol,
  side: record.side,
  quantity: record.quantity,
  price: record.price,
  executedAt: new Date(record.executedAt),
  notes: record.notes,
});

const compareTrades = (a: TradeRecordData, b: TradeRecordData): number => {
  const timeDiff = new Date(a.executedAt).getTime() - new Date(b.executedAt).getTime();
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return a.id.localeCompare(b.id);
};

const parseStore = (payload: string): PortfolioStoreData | null => {
  try {
    const parsed = JSON.parse(payload) as Partial<PortfolioStoreData>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    if (!Array.isArray(parsed.stocks) || !Array.isArray(parsed.trades)) {
      return null;
    }

    return {
      version: typeof parsed.version === "number" ? parsed.version : 0,
      stocks: parsed.stocks.map((stock) => ({
        symbol: String(stock.symbol ?? "").toUpperCase(),
        name: String(stock.name ?? ""),
        createdAt: new Date(stock.createdAt ?? Date.now()).toISOString(),
      })),
      trades: parsed.trades.map((trade) => ({
        id: String(trade.id ?? ""),
        symbol: String(trade.symbol ?? "").toUpperCase(),
        side: trade.side === "SELL" ? "SELL" : "BUY",
        quantity: Number(trade.quantity ?? 0),
        price: Number(trade.price ?? 0),
        executedAt: new Date(trade.executedAt ?? Date.now()).toISOString(),
        notes: typeof trade.notes === "string" ? trade.notes : undefined,
      })),
    } satisfies PortfolioStoreData;
  } catch {
    return null;
  }
};

export class FilePortfolioRepository implements PortfolioRepository {
  private store: PortfolioStoreData | null = null;

  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    if (this.store) {
      return;
    }

    await ensureDirectory(this.filePath);

    try {
      const payload = await fs.readFile(this.filePath, "utf-8");
      const parsed = parseStore(payload);
      if (parsed) {
        this.store = this.migrateIfNeeded(parsed);
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    this.store = this.buildSeedStore();
    await this.persist();
  }

  async reset(): Promise<void> {
    this.store = this.buildSeedStore();
    await this.persist();
  }

  async listStocks(): Promise<Stock[]> {
    const store = await this.getStore();
    return [...store.stocks]
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .map((record) => toStock(record));
  }

  async findStock(symbol: string): Promise<Stock | undefined> {
    const store = await this.getStore();
    const record = store.stocks.find((stock) => stock.symbol === symbol.toUpperCase());
    return record ? toStock(record) : undefined;
  }

  async createStock(record: CreateStockRecord): Promise<Stock> {
    const store = await this.getStore();
    const symbol = record.symbol.toUpperCase();
    if (store.stocks.some((stock) => stock.symbol === symbol)) {
      throw new RepositoryConflictError(`Stock ${symbol} already exists`);
    }

    const entry: StockRecordData = {
      symbol,
      name: record.name,
      createdAt: record.createdAt.toISOString(),
    };

    store.stocks.push(entry);
    await this.persist();

    return toStock(entry);
  }

  async ensureStock(record: CreateStockRecord): Promise<Stock> {
    const existing = await this.findStock(record.symbol);
    if (existing) {
      return existing;
    }
    return this.createStock(record);
  }

  async listTrades(): Promise<Trade[]> {
    const store = await this.getStore();
    return [...store.trades]
      .sort(compareTrades)
      .map((record) => toTrade(record));
  }

  async createTrade(record: CreateTradeRecord): Promise<Trade> {
    const store = await this.getStore();
    if (store.trades.some((trade) => trade.id === record.id)) {
      throw new RepositoryConflictError(`Trade ${record.id} already exists`);
    }

    const entry: TradeRecordData = {
      id: record.id,
      symbol: record.symbol.toUpperCase(),
      side: record.side,
      quantity: Math.round(record.quantity),
      price: Number(record.price),
      executedAt: record.executedAt.toISOString(),
      notes: record.notes,
    };

    store.trades.push(entry);
    store.trades.sort(compareTrades);
    await this.persist();

    return toTrade(entry);
  }

  async createTradeIfMissing(record: CreateTradeRecord): Promise<boolean> {
    const store = await this.getStore();
    if (store.trades.some((trade) => trade.id === record.id)) {
      return false;
    }

    const entry: TradeRecordData = {
      id: record.id,
      symbol: record.symbol.toUpperCase(),
      side: record.side,
      quantity: Math.round(record.quantity),
      price: Number(record.price),
      executedAt: record.executedAt.toISOString(),
      notes: record.notes,
    };

    store.trades.push(entry);
    store.trades.sort(compareTrades);
    await this.persist();
    return true;
  }

  private async getStore(): Promise<PortfolioStoreData> {
    if (!this.store) {
      await this.initialize();
    }

    if (!this.store) {
      throw new Error("Portfolio store failed to load");
    }

    return this.store;
  }

  private buildSeedStore(): PortfolioStoreData {
    const stocks: StockRecordData[] = seedStocks.map((stock) => ({
      symbol: stock.symbol.toUpperCase(),
      name: stock.name.trim(),
      createdAt: new Date().toISOString(),
    }));

    const trades: TradeRecordData[] = seedTrades.map((trade) => ({
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

    trades.sort(compareTrades);

    return {
      version: CURRENT_VERSION,
      stocks,
      trades,
    };
  }

  private migrateIfNeeded(store: PortfolioStoreData): PortfolioStoreData {
    if (store.version === CURRENT_VERSION) {
      return store;
    }

    // Placeholder for future migrations. For now just bump the version.
    return {
      ...store,
      version: CURRENT_VERSION,
    };
  }

  private async persist(): Promise<void> {
    const store = await this.getStore();
    const payload = JSON.stringify(store, null, 2);
    this.writeTail = this.writeTail.then(async () => {
      await ensureDirectory(this.filePath);
      await fs.writeFile(this.filePath, payload, "utf-8");
    });
    await this.writeTail;
  }
}

export default FilePortfolioRepository;
