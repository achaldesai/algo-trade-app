import { z } from "zod";

export const riskLimitsSchema = z.object({
    maxDailyLoss: z.number().positive("Max daily loss must be positive").optional(),
    maxDailyLossPercent: z.number().min(0).max(100).optional(),
    maxPositionSize: z.number().positive("Max position size must be positive").optional(),
    maxPositionSizePerSymbol: z.number().positive("Max position size per symbol must be positive").optional(),
    maxOpenPositions: z.number().int().positive("Max open positions must be a positive integer").optional(),
    stopLossPercent: z.number().min(0.1).max(100).optional(),
    circuitBroken: z.boolean().optional()
});

export type RiskLimitsUpdate = z.infer<typeof riskLimitsSchema>;

export const scannerUniverseSchema = z.object({
    symbols: z
        .array(z.string().regex(/^[A-Z0-9&\-.]+$/i, "Symbols must be alphanumeric (with optional & - .)"))
        .min(1, "Universe cannot be empty")
        .max(500, "Universe is capped at 500 symbols"),
});

export type ScannerUniverseUpdate = z.infer<typeof scannerUniverseSchema>;
