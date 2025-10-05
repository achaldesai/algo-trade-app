import { Router } from "express";
import { z } from "zod";
import portfolioService from "../container";
import { validateBody } from "../middleware/validateRequest";

const router = Router();

const createTradeSchema = z.object({
  symbol: z.string().min(1, "Symbol is required"),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number().int().positive("Quantity must be positive"),
  price: z.number().positive("Price must be positive"),
  executedAt: z.string().datetime().optional(),
  notes: z.string().max(200).optional(),
});

router.get("/", (_req, res) => {
  const trades = portfolioService.listTrades().map((trade) => ({
    ...trade,
    executedAt: trade.executedAt.toISOString(),
  }));
  res.json({ data: trades });
});

router.post("/", validateBody(createTradeSchema), (req, res) => {
  const { executedAt, ...rest } = req.body as z.infer<typeof createTradeSchema>;
  const trade = portfolioService.addTrade({
    ...rest,
    executedAt: executedAt ? new Date(executedAt) : undefined,
  });

  res.status(201).json({
    data: {
      ...trade,
      executedAt: trade.executedAt.toISOString(),
    },
  });
});

router.get("/summary", (_req, res) => {
  const summaries = portfolioService.getTradeSummaries();
  res.json({ data: summaries });
});

export default router;
