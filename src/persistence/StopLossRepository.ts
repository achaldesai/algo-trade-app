import { EventEmitter } from "events";

export type StopLossType = "FIXED" | "TRAILING";

export interface StopLossConfig {
    symbol: string;
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
    getAll(): StopLossConfig[];
    get(symbol: string): StopLossConfig | undefined;
    save(config: StopLossConfig): Promise<void>;
    delete(symbol: string): Promise<void>;
    close(): Promise<void>;
}
