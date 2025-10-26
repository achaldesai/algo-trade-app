import { Router } from "express";
import { z } from "zod";
import { resolveMarketDataService } from "../container";
import { validateBody } from "../middleware/validateRequest";

const router = Router();

const tickSchema = z.object({
  symbol: z.string().min(1),
  price: z.number().positive(),
  volume: z.number().nonnegative(),
  timestamp: z.string().datetime().optional(),
});

router.get("/", (req, res) => {
  const marketDataService = resolveMarketDataService();
  const symbols = Array.isArray(req.query.symbol)
    ? req.query.symbol.map((value) => value.toString())
    : typeof req.query.symbol === "string"
      ? [req.query.symbol]
      : undefined;

  const snapshot = marketDataService.getSnapshot(symbols);
  res.json({ data: snapshot });
});

router.post("/ticks", validateBody(z.object({ tick: tickSchema })), (req, res) => {
  const { tick } = req.body as { tick: z.infer<typeof tickSchema> };
  const marketDataService = resolveMarketDataService();
  const stored = marketDataService.updateTick(tick);
  res.status(201).json({ data: stored });
});

router.post("/batch", validateBody(z.object({ ticks: z.array(tickSchema).min(1) })), (req, res) => {
  const { ticks } = req.body as { ticks: z.infer<typeof tickSchema>[] };
  const marketDataService = resolveMarketDataService();
  const stored = ticks.map((tick) => marketDataService.updateTick(tick));
  res.status(201).json({ data: stored });
});

export default router;
