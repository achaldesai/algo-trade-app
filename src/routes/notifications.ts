import { Router, type Request, type Response } from "express";
import { getContainer } from "../util/getContainer";
import logger from "../utils/logger";

const router = Router();

router.get("/status", (req: Request, res: Response) => {
    try {
        const { notificationService } = getContainer(req);
        const configured = notificationService.isConfigured();

        res.json({
            configured,
            message: configured
                ? "Notifications are configured and active"
                : "No webhook URL configured. Set DISCORD_WEBHOOK_URL or WEBHOOK_URL environment variable.",
        });
    } catch (error) {
        logger.error({ err: error }, "Failed to check notification status");
        res.status(500).json({ error: "Failed to check notification status" });
    }
});

router.post("/test", async (req: Request, res: Response) => {
    try {
        const { notificationService } = getContainer(req);
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
