import { Router } from "express";
import { z } from "zod";
import { getContainer } from "../util/getContainer";
import { asyncHandler } from "../util/asyncHandler";
import { userAuthMiddleware } from "../middleware/userAuth";
import { DEFAULT_COST_BPS, MAX_SYMBOLS } from "../services/BacktestService";

const router = Router();
router.use(userAuthMiddleware);

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD format")
  .transform((s) => new Date(`${s}T00:00:00.000Z`))
  .refine((d) => !Number.isNaN(d.getTime()), "Invalid date");

const runSchema = z.object({
  strategyId: z.string().min(1),
  symbols: z.array(z.string().min(1).max(30)).min(1).max(MAX_SYMBOLS),
  from: dateOnly,
  to: dateOnly,
  params: z.record(z.unknown()).optional(),
  initialCapital: z.number().positive().max(1e12).default(1_000_000),
  costBps: z.number().min(0).max(500).default(DEFAULT_COST_BPS),
});

// Run a backtest, save it to the caller's history, return the full result.
// Parsed in the handler: validateBody can't carry the string -> Date transform.
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = runSchema.parse(req.body);
    // `to` is inclusive: cover the whole end day.
    const to = new Date(body.to.getTime() + 86_400_000 - 1);
    const run = await getContainer(req).backtestService.run(req.user!.userId, { ...body, to });
    res.status(201).json({ data: run });
  }),
);

router.get("/", (req, res) => {
  res.json({ data: getContainer(req).backtestService.list(req.user!.userId) });
});

router.get("/:id", (req, res) => {
  res.json({ data: getContainer(req).backtestService.get(req.user!.userId, req.params.id) });
});

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await getContainer(req).backtestService.delete(req.user!.userId, req.params.id);
    res.status(204).end();
  }),
);

export default router;
