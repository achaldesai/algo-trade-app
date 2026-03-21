import { createHash } from "node:crypto";

export interface TradeIdInput {
    symbol: string;
    side: string;
    executedAt: Date;
    price: number;
    quantity: number;
    notes?: string;
}

/**
 * Generate a deterministic trade ID from trade properties.
 * Used when importing external trades to avoid duplicates.
 */
export const deterministicTradeId = (input: TradeIdInput): string => {
    const seedKey = `${input.symbol}-${input.side}-${input.executedAt.toISOString()}-${input.price}-${input.quantity}-${input.notes ?? ""}`;
    const hash = createHash("sha1").update(seedKey).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
};
