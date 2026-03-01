import { EventEmitter } from "events";

export type StopLossType = "FIXED" | "TRAILING";

export interface StopLossConfig {
    symbol: string;
    userId: string;
    entryPrice: number;
    stopLossPrice: number;
    quantity: number;
    type: StopLossType;
    trailingPercent?: number;
    highWaterMark?: number; // For trailing stop - tracks highest price since entry
    createdAt: Date;
    updatedAt: Date;
}

export interface StopLossRepository extends EventEmitter {
    initialize(): Promise<void>;
    getAll(userId: string): StopLossConfig[];
    get(userId: string, symbol: string): StopLossConfig | undefined;
    getBySymbol(symbol: string): StopLossConfig[];
    save(config: StopLossConfig): Promise<void>;
    delete(userId: string, symbol: string): Promise<void>;
    close(): Promise<void>;
}
