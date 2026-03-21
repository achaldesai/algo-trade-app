import type { Stock, Trade, TradeSide } from "../../types";
import type {
    StockRecord,
    TradeRecord,
} from "../DatabaseManager";
import type DatabaseManager from "../DatabaseManager";
import { RepositoryConflictError } from "./errors";
import { deterministicTradeId } from "./storeUtils";

// ─── Input Types ─────────────────────────────────────────────────────────────

export interface CreateStockInput {
    symbol: string;
    name: string;
    createdAt?: Date;
}

export interface CreateTradeInput {
    id: string;
    symbol: string;
    side: TradeSide;
    quantity: number;
    price: number;
    executedAt: Date;
    notes?: string;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export class PortfolioRepo {
    private readonly db: DatabaseManager;

    constructor(db: DatabaseManager) {
        this.db = db;
    }

    // ─── Stock Operations ──────────────────────────────────────────────────────

    listStocks(userId: string): Stock[] {
        const { stocks } = this.db.handles;
        const result: Stock[] = [];

        for (const { value } of stocks.getRange({
            start: `${userId}:`,
            end: `${userId};\uffff`,
        })) {
            result.push(toStock(value));
        }

        return result.sort((a, b) => a.symbol.localeCompare(b.symbol));
    }

    findStock(userId: string, symbol: string): Stock | undefined {
        const { stocks } = this.db.handles;
        const record = stocks.get(`${userId}:${symbol.toUpperCase()}`);
        return record ? toStock(record) : undefined;
    }

    async createStock(userId: string, input: CreateStockInput): Promise<Stock> {
        const { stocks } = this.db.handles;
        const symbol = input.symbol.toUpperCase();
        const key = `${userId}:${symbol}`;

        const existing = stocks.get(key);
        if (existing) {
            throw new RepositoryConflictError(
                `Stock ${symbol} already exists for user ${userId}`
            );
        }

        const record: StockRecord = {
            userId,
            symbol,
            name: input.name,
            createdAt: (input.createdAt ?? new Date()).toISOString(),
        };

        await stocks.put(key, record);
        return toStock(record);
    }

    async ensureStock(userId: string, input: CreateStockInput): Promise<Stock> {
        const existing = this.findStock(userId, input.symbol);
        if (existing) return existing;
        return this.createStock(userId, input);
    }

    // ─── Trade Operations ──────────────────────────────────────────────────────

    listTrades(userId: string): Trade[] {
        const { trades } = this.db.handles;
        const result: Trade[] = [];

        for (const { value } of trades.getRange({
            start: `${userId}:`,
            end: `${userId};\uffff`,
        })) {
            result.push(toTrade(value));
        }

        return result.sort((a, b) => {
            const diff = a.executedAt.getTime() - b.executedAt.getTime();
            if (diff !== 0) return diff;
            return a.id.localeCompare(b.id);
        });
    }

    async createTrade(userId: string, input: CreateTradeInput): Promise<Trade> {
        const { trades } = this.db.handles;
        const key = `${userId}:${input.id}`;

        const existing = trades.get(key);
        if (existing) {
            throw new RepositoryConflictError(`Trade ${input.id} already exists`);
        }

        const record = toTradeRecord(userId, input);
        await trades.put(key, record);
        return toTrade(record);
    }

    async createTradeIfMissing(
        userId: string,
        input: CreateTradeInput
    ): Promise<boolean> {
        const { trades } = this.db.handles;
        const key = `${userId}:${input.id}`;

        const existing = trades.get(key);
        if (existing) return false;

        const record = toTradeRecord(userId, input);
        await trades.put(key, record);
        return true;
    }

    // ─── Atomic Operations ─────────────────────────────────────────────────────

    /**
     * Atomically create a stock (if missing) and record a trade.
     * Both operations are committed together or not at all.
     */
    async recordTradeAtomic(
        userId: string,
        stockInput: CreateStockInput,
        tradeInput: CreateTradeInput
    ): Promise<{ stock: Stock; trade: Trade; created: boolean }> {
        return this.db.withTransaction(async (tx) => {
            const symbol = stockInput.symbol.toUpperCase();
            const stockKey = `${userId}:${symbol}`;
            const tradeKey = `${userId}:${tradeInput.id}`;

            // Ensure stock
            let stockRecord = tx.stocks.get(stockKey);
            let stockCreated = false;
            if (!stockRecord) {
                stockRecord = {
                    userId,
                    symbol,
                    name: stockInput.name,
                    createdAt: (stockInput.createdAt ?? new Date()).toISOString(),
                };
                await tx.stocks.put(stockKey, stockRecord);
                stockCreated = true;
            }

            // Create trade (skip if already exists for idempotency)
            let tradeRecord = tx.trades.get(tradeKey);
            if (!tradeRecord) {
                tradeRecord = toTradeRecord(userId, tradeInput);
                await tx.trades.put(tradeKey, tradeRecord);
            }

            return {
                stock: toStock(stockRecord),
                trade: toTrade(tradeRecord),
                created: stockCreated,
            };
        });
    }
}

// ─── Conversion Helpers ────────────────────────────────────────────────────────

function toStock(record: StockRecord): Stock {
    return {
        symbol: record.symbol,
        name: record.name,
        createdAt: new Date(record.createdAt),
    };
}

function toTrade(record: TradeRecord): Trade {
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

function toTradeRecord(userId: string, input: CreateTradeInput): TradeRecord {
    return {
        id: input.id,
        userId,
        symbol: input.symbol.toUpperCase(),
        side: input.side,
        quantity: Math.round(input.quantity),
        price: Number(input.price),
        executedAt: input.executedAt.toISOString(),
        notes: input.notes,
    };
}

export { toStock, toTrade, deterministicTradeId };
