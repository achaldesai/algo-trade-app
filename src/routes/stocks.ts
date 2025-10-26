import { Router } from "express";
import { z } from "zod";
import { resolvePortfolioService } from "../container";
import { validateBody } from "../middleware/validateRequest";

const router = Router();

const createStockSchema = z.object({
  symbol: z.string().min(1, "Symbol is required"),
  name: z.string().min(1, "Name is required"),
});

router.get("/", async (_req, res, next) => {
  try {
    const portfolioService = resolvePortfolioService();
    const stocks = await portfolioService.listStocks();
    res.json({
      data: stocks.map((stock) => ({
        ...stock,
        createdAt: stock.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/", validateBody(createStockSchema), async (req, res, next) => {
  try {
    const portfolioService = resolvePortfolioService();
    const stock = await portfolioService.addStock(req.body);
    res.status(201).json({
      data: {
        ...stock,
        createdAt: stock.createdAt.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
