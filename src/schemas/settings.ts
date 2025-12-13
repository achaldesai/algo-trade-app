import { z } from "zod";

export const riskLimitsSchema = z.object({
    maxDailyLoss: z.number().positive("Max daily loss must be positive").optional(),
    maxDailyLossPercent: z.number().min(0).max(100).optional(),
    maxPositionSize: z.number().positive("Max position size must be positive").optional(),
    maxOpenPositions: z.number().int().positive("Max open positions must be a positive integer").optional(),
    stopLossPercent: z.number().min(0.1).max(100).optional(),
    circuitBroken: z.boolean().optional()
});

export type RiskLimitsUpdate = z.infer<typeof riskLimitsSchema>;
