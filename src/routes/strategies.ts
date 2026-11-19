import { Router } from "express";
import { z } from "zod";
import { getContainer } from "../util/getContainer";
import { validateBody } from "../middleware/validateRequest";
import { userAuthMiddleware } from "../middleware/userAuth";
import { HttpError } from "../utils/HttpError";
import { resolveStrategyParams } from "../strategies/validateParams";
import env, { isPaperMode } from "../config/env";
import { asyncHandler } from "../util/asyncHandler";
import logger from "../utils/logger";

/** Most symbols one daily strategy config may trade (same as a backtest). */
export const MAX_CONFIG_SYMBOLS = 10;

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
  // Daily strategies only. Omitted or empty = every tracked (WATCHLIST) symbol.
  symbols: z
    .array(z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9&-]+$/, "Symbols are letters, digits, & or -"))
    .max(MAX_CONFIG_SYMBOLS)
    .optional()
    .transform((list) => (list ? [...new Set(list.map((s) => s.toUpperCase()))] : undefined)),
});

// ─── List all available strategies + param schemas ───────────────────────────

router.get("/", (req, res) => {
  const { tradingEngine } = getContainer(req);
  const strategies = tradingEngine.getStrategies().map((strategy) => ({
    id: strategy.id,
    name: strategy.name,
    description: strategy.description,
    timeframe: strategy.timeframe,
    backtestable: strategy.timeframe === "1day",
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
        timeframe: strategy.timeframe,
        paramSchema: strategy.getParamSchema(),
        defaultParams: strategy.getDefaultParams(),
        // User's custom config (null if using defaults)
        userConfig: userConfig
          ? {
            enabled: userConfig.enabled,
            params: userConfig.params,
            symbols: userConfig.symbols ?? null,
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

      // Merge user params with defaults and validate against the schema
      const mergedParams = resolveStrategyParams(strategy, body.params);
      // Symbols only steer daily strategies; tick strategies follow the live feed.
      const symbols = strategy.timeframe === "1day" && body.symbols?.length ? body.symbols : undefined;

      await strategyConfigRepo.saveConfig(userId, {
        strategyId,
        enabled: body.enabled,
        params: mergedParams,
        ...(symbols ? { symbols } : {}),
        updatedAt: new Date().toISOString(),
      });

      res.json({
        data: {
          strategyId,
          enabled: body.enabled,
          params: mergedParams,
          symbols: symbols ?? null,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

// ─── Daily strategy run status for the caller ────────────────────────────────
//
// What the dashboard's Live strategies panel needs to show whether the 15:15
// IST run will do anything for this user. User-level, unlike /api/control/status.

router.get(
  "/daily-status",
  asyncHandler(async (req, res) => {
    const { dailyStrategyRunner, tradingLoopService, marketDataService, strategyConfigRepo, tradingEngine, accountService, brokerFactory } =
      getContainer(req);
    const userId = req.user!.userId;
    // Symbols that get live prices: the WATCHLIST (subscribed at startup), plus
    // any others already ticking. getTrackedSymbols() alone is empty off-hours.
    const tracked = [...new Set([...env.watchlist.map((s) => s.toUpperCase()), ...marketDataService.getTrackedSymbols()])];
    const daily = new Map(tradingEngine.getStrategies().filter((s) => s.timeframe === "1day").map((s) => [s.id, s]));

    const strategies = strategyConfigRepo
      .getActiveStrategies(userId)
      .filter((c) => daily.has(c.strategyId))
      .map((c) => {
        const symbols = c.symbols?.length ? c.symbols : tracked;
        return {
          strategyId: c.strategyId,
          name: daily.get(c.strategyId)!.name,
          symbols,
          // Configured symbols without a live feed are skipped at run time.
          notTracked: symbols.filter((s) => !tracked.includes(s)),
          sizing: c.params.sizing === "percent" ? "percent" : "shares",
        };
      });

    let account: { cash: number; equity: number } | null = null;
    try {
      account = (await accountService.getAccount(userId, await brokerFactory.getBroker(userId))) ?? null;
    } catch (error) {
      logger.warn({ err: error, userId }, "Could not read the account for daily status");
    }

    const runner = dailyStrategyRunner.getStatus();
    res.json({
      data: {
        paperMode: isPaperMode(),
        tradingOn: tradingLoopService.getStatus().running,
        nextRunAt: runner.nextRunAt,
        lastRun: runner.lastRun,
        trackedSymbols: tracked,
        account,
        strategies,
      },
    });
  }),
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
