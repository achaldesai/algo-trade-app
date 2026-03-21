import type { Pool } from "pg";
import type { Trade, TradeSide } from "../../types";

export interface PgCreateTradeInput {
    id: string;
    userId: string;
    symbol: string;
    side: TradeSide;
    quantity: number;
    price: number;
    executedAt: Date;
    notes?: string;
}

/**
 * PgTradeRepo — PostgreSQL-backed trade repository.
 *
 * Provides indexed queries by user, symbol, and date range.
 * Used for historical trade storage and P&L analytics.
 */
export class PgTradeRepo {
    constructor(private readonly pool: Pool) { }

    async createTrade(input: PgCreateTradeInput): Promise<Trade> {
        const result = await this.pool.query(
            `INSERT INTO trades (id, user_id, symbol, side, quantity, price, executed_at, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO NOTHING
             RETURNING *`,
            [
                input.id,
                input.userId,
                input.symbol.toUpperCase(),
                input.side,
                Math.round(input.quantity),
                input.price,
                input.executedAt,
                input.notes ?? null,
            ]
        );

        if (result.rows.length === 0) {
            // Trade already existed (idempotent)
            const existing = await this.pool.query(
                "SELECT * FROM trades WHERE id = $1",
                [input.id]
            );
            return toTrade(existing.rows[0]);
        }

        return toTrade(result.rows[0]);
    }

    async listTrades(userId: string): Promise<Trade[]> {
        const result = await this.pool.query(
            `SELECT * FROM trades
             WHERE user_id = $1
             ORDER BY executed_at ASC, id ASC`,
            [userId]
        );
        return result.rows.map(toTrade);
    }

    async listTradesBySymbol(userId: string, symbol: string): Promise<Trade[]> {
        const result = await this.pool.query(
            `SELECT * FROM trades
             WHERE user_id = $1 AND symbol = $2
             ORDER BY executed_at ASC`,
            [userId, symbol.toUpperCase()]
        );
        return result.rows.map(toTrade);
    }

    async listTradesByDateRange(
        userId: string,
        from: Date,
        to: Date
    ): Promise<Trade[]> {
        const result = await this.pool.query(
            `SELECT * FROM trades
             WHERE user_id = $1 AND executed_at >= $2 AND executed_at <= $3
             ORDER BY executed_at ASC`,
            [userId, from, to]
        );
        return result.rows.map(toTrade);
    }

    async getTradeCount(userId: string): Promise<number> {
        const result = await this.pool.query(
            "SELECT COUNT(*) as count FROM trades WHERE user_id = $1",
            [userId]
        );
        return parseInt(result.rows[0].count, 10);
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTrade(row: any): Trade {
    return {
        id: row.id,
        symbol: row.symbol,
        side: row.side as TradeSide,
        quantity: row.quantity,
        price: parseFloat(row.price),
        executedAt: new Date(row.executed_at),
        notes: row.notes ?? undefined,
    };
}
