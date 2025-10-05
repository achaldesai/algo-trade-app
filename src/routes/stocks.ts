import { Router } from "express";
import { z } from "zod";
import portfolioService from "../container";
import { validateBody } from "../middleware/validateRequest";

const router = Router();

const createStockSchema = z.object({
  symbol: z.string().min(1, "Symbol is required"),
  name: z.string().min(1, "Name is required"),
});

router.get("/", (_req, res) => {
  const stocks = portfolioService.listStocks().map((stock) => ({
    ...stock,
    createdAt: stock.createdAt.toISOString(),
  }));
  res.json({ data: stocks });
});

router.post("/", validateBody(createStockSchema), (req, res) => {
  const stock = portfolioService.addStock(req.body);
  res.status(201).json({
    data: {
      ...stock,
      createdAt: stock.createdAt.toISOString(),
    },
  });
});

export default router;
