import { Router, type Request, type Response } from "express";
import { resolveNotificationService } from "../container";
import logger from "../utils/logger";

const router = Router();

/**
 * GET /api/notifications/status
 * Check if notifications are configured
 */
router.get("/status", (_req: Request, res: Response) => {
    try {
        const notificationService = resolveNotificationService();
        const configured = notificationService.isConfigured();

        res.json({
            configured,
            message: configured
                ? "Notifications are configured and active"
                : "No webhook URL configured. Set DISCORD_WEBHOOK_URL or WEBHOOK_URL environment variable."
        });
    } catch (error) {
        logger.error({ err: error }, "Failed to check notification status");
        res.status(500).json({ error: "Failed to check notification status" });
    }
});

/**
 * POST /api/notifications/test
 * Send a test notification
 */
router.post("/test", async (_req: Request, res: Response) => {
    try {
        const notificationService = resolveNotificationService();
        const result = await notificationService.sendTestNotification();

        if (result.success) {
            res.json({ success: true, message: result.message });
        } else {
            res.status(400).json({ success: false, message: result.message });
        }
    } catch (error) {
        logger.error({ err: error }, "Failed to send test notification");
        res.status(500).json({ success: false, message: "Failed to send test notification" });
    }
});

export default router;
