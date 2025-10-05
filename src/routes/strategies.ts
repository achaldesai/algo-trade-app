import { Router } from "express";
import { z } from "zod";
import { marketDataService, tradingEngine } from "../container";
import { validateBody } from "../middleware/validateRequest";

const router = Router();

const evaluateSchema = z.object({
  ticks: z
    .array(
      z.object({
        symbol: z.string().min(1),
        price: z.number().positive(),
        volume: z.number().nonnegative(),
        timestamp: z.string().datetime().optional(),
      }),
    )
    .optional(),
});

router.get("/", (_req, res) => {
  const strategies = tradingEngine.getStrategies().map((strategy) => ({
    id: strategy.id,
    name: strategy.name,
    description: strategy.description,
  }));

  res.json({ data: strategies });
});

router.post(
  "/:strategyId/evaluate",
  validateBody(evaluateSchema),
  async (req, res, next) => {
    try {
      const { strategyId } = req.params;
      const payload = req.body as z.infer<typeof evaluateSchema>;

      payload.ticks?.forEach((tick) => {
        marketDataService.updateTick({
          symbol: tick.symbol,
          price: tick.price,
          volume: tick.volume,
          timestamp: tick.timestamp,
        });
      });

      const result = await tradingEngine.evaluate(strategyId);
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
