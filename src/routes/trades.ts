import { Router } from "express";
import { z } from "zod";
import { resolvePortfolioService } from "../container";
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

router.get("/", async (_req, res, next) => {
  try {
    const portfolioService = resolvePortfolioService();
    const trades = await portfolioService.listTrades();
    res.json({
      data: trades.map((trade) => ({
        ...trade,
        executedAt: trade.executedAt.toISOString(),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/", validateBody(createTradeSchema), async (req, res, next) => {
  try {
    const portfolioService = resolvePortfolioService();
    const { executedAt, ...rest } = req.body as z.infer<typeof createTradeSchema>;
    const trade = await portfolioService.addTrade({
      ...rest,
      executedAt: executedAt ? new Date(executedAt) : undefined,
    });

    res.status(201).json({
      data: {
        ...trade,
        executedAt: trade.executedAt.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/summary", async (_req, res, next) => {
  try {
    const portfolioService = resolvePortfolioService();
    const summaries = await portfolioService.getTradeSummaries();
    res.json({ data: summaries });
  } catch (error) {
    next(error);
  }
});

router.get("/portfolio", async (_req, res, next) => {
  try {
    const portfolioService = resolvePortfolioService();
    const snapshot = await portfolioService.getSnapshot();
    res.json({
      data: {
        ...snapshot,
        generatedAt: snapshot.generatedAt.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
