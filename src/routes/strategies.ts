import { Router } from "express";
import { z } from "zod";
import { getContainer } from "../util/getContainer";
import { validateBody } from "../middleware/validateRequest";
import { userAuthMiddleware } from "../middleware/userAuth";
import { HttpError } from "../utils/HttpError";

const router = Router();
router.use(userAuthMiddleware);

// ─── Schemas ─────────────────────────────────────────────────────────────────

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

const strategyConfigSchema = z.object({
  enabled: z.boolean(),
  params: z.record(z.unknown()).optional(),
});

// ─── List all available strategies + param schemas ───────────────────────────

router.get("/", (req, res) => {
  const { tradingEngine } = getContainer(req);
  const strategies = tradingEngine.getStrategies().map((strategy) => ({
    id: strategy.id,
    name: strategy.name,
    description: strategy.description,
    paramSchema: strategy.getParamSchema(),
    defaultParams: strategy.getDefaultParams(),
  }));

  res.json({ data: strategies });
});

// ─── Get user's strategy configurations ──────────────────────────────────────

router.get("/config", (req, res, next) => {
  try {
    const { strategyConfigRepo, tradingEngine } = getContainer(req);
    const userId = req.user!.userId;

    const userConfigs = strategyConfigRepo.getAllConfigs(userId);
    const allStrategies = tradingEngine.getStrategies();

    // Build a complete view: all strategies with user's config overlaid
    const result = allStrategies.map((strategy) => {
      const userConfig = userConfigs.find((c) => c.strategyId === strategy.id);
      return {
        strategyId: strategy.id,
        name: strategy.name,
        description: strategy.description,
        paramSchema: strategy.getParamSchema(),
        defaultParams: strategy.getDefaultParams(),
        // User's custom config (null if using defaults)
        userConfig: userConfig
          ? {
            enabled: userConfig.enabled,
            params: userConfig.params,
            updatedAt: userConfig.updatedAt,
          }
          : null,
      };
    });

    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

// ─── Save strategy configuration for user ────────────────────────────────────

router.put(
  "/config/:strategyId",
  validateBody(strategyConfigSchema),
  async (req, res, next) => {
    try {
      const { strategyConfigRepo, tradingEngine } = getContainer(req);
      const userId = req.user!.userId;
      const { strategyId } = req.params;

      // Verify strategy exists
      const strategy = tradingEngine.getStrategy(strategyId);
      if (!strategy) {
        throw new HttpError(404, `Unknown strategy: ${strategyId}`);
      }

      const body = req.body as z.infer<typeof strategyConfigSchema>;

      // Merge user params with defaults (only override what's provided)
      const defaults = strategy.getDefaultParams();
      const mergedParams = { ...defaults, ...(body.params ?? {}) };

      // Validate param values against schema constraints
      const paramSchema = strategy.getParamSchema();
      for (const def of paramSchema) {
        const val = mergedParams[def.key];
        if (val === undefined) continue;

        if (def.type === "number" && typeof val === "number") {
          if (def.min !== undefined && val < def.min) {
            throw new HttpError(400, `Parameter '${def.key}' must be >= ${def.min}`);
          }
          if (def.max !== undefined && val > def.max) {
            throw new HttpError(400, `Parameter '${def.key}' must be <= ${def.max}`);
          }
        }

        if (def.type === "select" && def.options) {
          const validValues = def.options.map((o) => o.value);
          if (!validValues.includes(String(val))) {
            throw new HttpError(400, `Parameter '${def.key}' must be one of: ${validValues.join(", ")}`);
          }
        }
      }

      await strategyConfigRepo.saveConfig(userId, {
        strategyId,
        enabled: body.enabled,
        params: mergedParams,
        updatedAt: new Date().toISOString(),
      });

      res.json({
        data: {
          strategyId,
          enabled: body.enabled,
          params: mergedParams,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

// ─── Delete strategy configuration (reset to defaults) ──────────────────────

router.delete("/config/:strategyId", async (req, res, next) => {
  try {
    const { strategyConfigRepo, tradingEngine } = getContainer(req);
    const userId = req.user!.userId;
    const { strategyId } = req.params;

    // Verify strategy exists
    const strategy = tradingEngine.getStrategy(strategyId);
    if (!strategy) {
      throw new HttpError(404, `Unknown strategy: ${strategyId}`);
    }

    const deleted = await strategyConfigRepo.deleteConfig(userId, strategyId);
    if (!deleted) {
      throw new HttpError(404, `No custom configuration found for strategy: ${strategyId}`);
    }

    res.json({ message: `Configuration for '${strategyId}' reset to defaults` });
  } catch (error) {
    next(error);
  }
});

// ─── Evaluate a strategy ─────────────────────────────────────────────────────

router.post(
  "/:strategyId/evaluate",
  validateBody(evaluateSchema),
  async (req, res, next) => {
    try {
      const { strategyId } = req.params;
      const payload = req.body as z.infer<typeof evaluateSchema>;
      const { tradingEngine, marketDataService, strategyConfigRepo } = getContainer(req);
      const userId = req.user!.userId;

      payload.ticks?.forEach((tick) => {
        marketDataService.updateTick({
          symbol: tick.symbol,
          price: tick.price,
          volume: tick.volume,
          timestamp: tick.timestamp,
        });
      });

      // Use user's custom params if they have a config for this strategy
      const userConfig = strategyConfigRepo.getConfig(userId, strategyId);
      const result = await tradingEngine.evaluate(
        strategyId,
        userId,
        userConfig?.params
      );
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
