import { Router } from "express";
import { getContainer } from "../util/getContainer";
import type { AuditEventType, AuditLogQuery } from "../persistence/AuditLogRepository";
import { adminAuthMiddleware } from "../middleware/adminAuth";

const router = Router();
router.use(adminAuthMiddleware);

router.get("/", async (req, res, next) => {
    try {
        const { auditLogService } = getContainer(req);

        const query: AuditLogQuery = {
            limit: Math.min(parseInt(req.query.limit as string) || 100, 500),
            offset: parseInt(req.query.offset as string) || 0,
        };

        if (req.query.from) query.fromDate = new Date(req.query.from as string);
        if (req.query.to) query.toDate = new Date(req.query.to as string);
        if (req.query.eventType) {
            query.eventTypes = (req.query.eventType as string).split(",") as AuditEventType[];
        }
        if (req.query.symbol) query.symbol = (req.query.symbol as string).toUpperCase();
        if (req.query.category) query.category = req.query.category as string;
        if (req.query.severity) query.severity = req.query.severity as string;

        const entries = await auditLogService.query(query);

        res.json({
            success: true,
            data: {
                entries: entries.map((e: { timestamp: Date }) => ({ ...e, timestamp: e.timestamp.toISOString() })),
                query: { ...query, fromDate: query.fromDate?.toISOString(), toDate: query.toDate?.toISOString() },
                count: entries.length,
            },
        });
    } catch (error) {
        next(error);
    }
});

router.get("/today", async (req, res, next) => {
    try {
        const { auditLogService } = getContainer(req);
        const entries = await auditLogService.getToday();

        res.json({
            success: true,
            data: {
                entries: entries.map((e: { timestamp: Date }) => ({ ...e, timestamp: e.timestamp.toISOString() })),
                count: entries.length,
                date: new Date().toISOString().split("T")[0],
            },
        });
    } catch (error) {
        next(error);
    }
});

router.get("/stats", async (req, res, next) => {
    try {
        const { auditLogService } = getContainer(req);
        const stats = await auditLogService.getStats();

        res.json({
            success: true,
            data: {
                stats,
                total: (Object.values(stats) as number[]).reduce((sum: number, count: number) => sum + count, 0),
            },
        });
    } catch (error) {
        next(error);
    }
});

router.get("/symbol/:symbol", async (req, res, next) => {
    try {
        const { auditLogService } = getContainer(req);
        const symbol = req.params.symbol.toUpperCase();

        const entries = await auditLogService.query({
            symbol,
            limit: parseInt(req.query.limit as string) || 100,
        });

        res.json({
            success: true,
            data: {
                symbol,
                entries: entries.map((e: { timestamp: Date }) => ({ ...e, timestamp: e.timestamp.toISOString() })),
                count: entries.length,
            },
        });
    } catch (error) {
        next(error);
    }
});

router.post("/cleanup", async (req, res, next) => {
    try {
        const { auditLogService } = getContainer(req);
        const retentionDays = parseInt(req.body?.retentionDays as string) || 30;
        const deleted = await auditLogService.cleanup(retentionDays);

        res.json({ success: true, data: { deleted, retentionDays } });
    } catch (error) {
        next(error);
    }
});

export default router;
