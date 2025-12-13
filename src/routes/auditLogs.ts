import { Router } from "express";
import { resolveAuditLogService } from "../container";
import type { AuditEventType, AuditLogQuery } from "../persistence/AuditLogRepository";
import { adminAuthMiddleware } from "../middleware/adminAuth";

const router = Router();

// Apply authentication middleware to all audit log routes
router.use(adminAuthMiddleware);

/**
 * GET /api/audit-logs
 * Query audit logs with optional filters
 */
router.get("/", async (req, res, next) => {
    try {
        const auditService = resolveAuditLogService();

        const query: AuditLogQuery = {
            limit: Math.min(parseInt(req.query.limit as string) || 100, 500),
            offset: parseInt(req.query.offset as string) || 0,
        };

        // Parse date filters
        if (req.query.from) {
            query.fromDate = new Date(req.query.from as string);
        }
        if (req.query.to) {
            query.toDate = new Date(req.query.to as string);
        }

        // Parse event type filter
        if (req.query.eventType) {
            const types = (req.query.eventType as string).split(",") as AuditEventType[];
            query.eventTypes = types;
        }

        // Other filters
        if (req.query.symbol) {
            query.symbol = (req.query.symbol as string).toUpperCase();
        }
        if (req.query.category) {
            query.category = req.query.category as string;
        }
        if (req.query.severity) {
            query.severity = req.query.severity as string;
        }

        const entries = await auditService.query(query);

        res.json({
            success: true,
            data: {
                entries: entries.map((e) => ({
                    ...e,
                    timestamp: e.timestamp.toISOString(),
                })),
                query: {
                    ...query,
                    fromDate: query.fromDate?.toISOString(),
                    toDate: query.toDate?.toISOString(),
                },
                count: entries.length,
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/audit-logs/today
 * Get today's audit log entries
 */
router.get("/today", async (_req, res, next) => {
    try {
        const auditService = resolveAuditLogService();
        const entries = await auditService.getToday();

        res.json({
            success: true,
            data: {
                entries: entries.map((e) => ({
                    ...e,
                    timestamp: e.timestamp.toISOString(),
                })),
                count: entries.length,
                date: new Date().toISOString().split("T")[0],
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/audit-logs/stats
 * Get audit log statistics by event type
 */
router.get("/stats", async (_req, res, next) => {
    try {
        const auditService = resolveAuditLogService();
        const stats = await auditService.getStats();

        res.json({
            success: true,
            data: {
                stats,
                total: (Object.values(stats) as number[]).reduce((sum, count) => sum + count, 0),
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/audit-logs/symbol/:symbol
 * Get audit logs for a specific symbol
 */
router.get("/symbol/:symbol", async (req, res, next) => {
    try {
        const auditService = resolveAuditLogService();
        const symbol = req.params.symbol.toUpperCase();

        const entries = await auditService.query({
            symbol,
            limit: parseInt(req.query.limit as string) || 100,
        });

        res.json({
            success: true,
            data: {
                symbol,
                entries: entries.map((e) => ({
                    ...e,
                    timestamp: e.timestamp.toISOString(),
                })),
                count: entries.length,
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/audit-logs/cleanup
 * Clean up old audit logs (admin only)
 */
router.post("/cleanup", async (req, res, next) => {
    try {
        const auditService = resolveAuditLogService();
        const retentionDays = parseInt(req.body?.retentionDays as string) || 30;

        const deleted = await auditService.cleanup(retentionDays);

        res.json({
            success: true,
            data: {
                deleted,
                retentionDays,
            },
        });
    } catch (error) {
        next(error);
    }
});

export default router;
