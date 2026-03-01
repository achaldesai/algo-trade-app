import { Router } from "express";
import { resolveMarketScannerService, resolveTickerClient } from "../container";
import { adminAuthMiddleware as adminAuth } from "../middleware/adminAuth";
import logger from "../utils/logger";

const router = Router();

/**
 * GET /api/scanner/scan
 * Manually trigger a market scan
 */
router.get("/scan", adminAuth, async (req, res) => {
  try {
    const scanner = resolveMarketScannerService();
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
    const picks = await scanner.scan(limit);

    res.json({
      success: true,
      count: picks.length,
      data: picks
    });
  } catch (error) {
    logger.error({ err: error }, "Manual scan failed");
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error"
    });
  }
});

/**
 * POST /api/scanner/apply
 * Apply the latest picks (subscribe and start trading)
 */
router.post("/apply", adminAuth, async (req, res) => {
  try {
    const scanner = resolveMarketScannerService();
    const tickerClient = resolveTickerClient();
    const picks = req.body.picks;

    if (!Array.isArray(picks)) {
      res.status(400).json({ success: false, error: "Picks must be an array" });
      return;
    }

    if (!tickerClient) {
      res.status(503).json({ success: false, error: "Ticker client not available" });
      return;
    }

    await scanner.applyPicks(picks, tickerClient);

    res.json({
      success: true,
      message: `Successfully applied ${picks.length} picks`
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to apply picks");
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error"
    });
  }
});

export default router;
