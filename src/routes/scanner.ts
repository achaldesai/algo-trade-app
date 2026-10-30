import { Router } from "express";
import { getContainer } from "../util/getContainer";
import { adminAuthMiddleware as adminAuth } from "../middleware/adminAuth";
import { HttpError } from "../utils/HttpError";
import logger from "../utils/logger";
import { scannerUniverseSchema } from "../schemas/settings";
import { DEFAULT_UNIVERSE } from "../services/MarketScannerService";

const router = Router();

router.get("/scan", adminAuth, async (req, res) => {
  try {
    const { marketScannerService } = getContainer(req);
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
    const picks = await marketScannerService.scan(limit);

    res.json({ success: true, count: picks.length, data: picks });
  } catch (error) {
    logger.error({ err: error }, "Manual scan failed");
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Internal server error" });
  }
});

router.post("/apply", adminAuth, async (req, res) => {
  try {
    const { marketScannerService, tickerClient } = getContainer(req);
    const picks = req.body.picks;

    if (!Array.isArray(picks)) {
      res.status(400).json({ success: false, error: "Picks must be an array" });
      return;
    }

    if (!tickerClient) {
      res.status(503).json({ success: false, error: "Ticker client not available" });
      return;
    }

    await marketScannerService.applyPicks(picks, tickerClient);
    res.json({ success: true, message: `Successfully applied ${picks.length} picks` });
  } catch (error) {
    logger.error({ err: error }, "Failed to apply picks");
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Internal server error" });
  }
});

router.get("/universe", adminAuth, (req, res, next) => {
  try {
    const { settingsRepo } = getContainer(req);
    const persisted = settingsRepo.getUniverse();
    res.json({
      success: true,
      data: {
        symbols: persisted ?? [...DEFAULT_UNIVERSE],
        isDefault: persisted === undefined,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.put("/universe", adminAuth, async (req, res, next) => {
  try {
    const { settingsRepo } = getContainer(req);
    const parsed = scannerUniverseSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.errors.map(e => e.message).join(", "));
    }

    await settingsRepo.saveUniverse(parsed.data.symbols);
    const stored = settingsRepo.getUniverse() ?? [];
    logger.info({ count: stored.length }, "Scanner universe updated");
    res.json({ success: true, data: { symbols: stored } });
  } catch (error) {
    next(error);
  }
});

export default router;
