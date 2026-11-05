import logger from "../utils/logger";
import { isIndianMarketHours, IST_OFFSET_MS } from "../utils/marketHours";
import type MarketDataService from "./MarketDataService";
import type { NotificationService } from "./NotificationService";
import type { AuditLogService } from "./AuditLogService";

const CHECK_INTERVAL_MS = 10_000;
const STALENESS_TIMEOUT_MS = 30_000;

export interface FeedHealthMonitorDeps {
    marketDataService: Pick<MarketDataService, "getTrackedSymbols" | "getTick">;
    tradingLoopService: { start(): void; stop(): void };
    notificationService: Pick<NotificationService, "notifyCriticalError" | "notifyFeedRecovered">;
    auditLogService: Pick<AuditLogService, "log">;
    now?: () => Date;
}

/**
 * FeedHealthMonitor is a session-aware fail-safe kill switch: if the market-data
 * feed stays connected but stops emitting ticks during market hours, stale
 * last-prices would keep the trading loop acting on dead data. This monitor
 * periodically checks the age of the newest tracked tick and halts the trading
 * loop (and alerts) when the feed has gone silent for longer than
 * `STALENESS_TIMEOUT_MS` — but only after the feed has actually produced a fresh
 * tick in the current market session, so it never falsely halts at market open
 * (using yesterday's cached tick) or on a weekday exchange holiday. When the
 * feed recovers it auto-resumes the trading loop and notifies.
 */
export class FeedHealthMonitor {
    private running = false;
    private halted = false;
    private sessionKey = "";
    private sawFreshThisSession = false;
    private timer?: NodeJS.Timeout;

    private readonly marketDataService: Pick<MarketDataService, "getTrackedSymbols" | "getTick">;
    private readonly tradingLoopService: { start(): void; stop(): void };
    private readonly notificationService: Pick<NotificationService, "notifyCriticalError" | "notifyFeedRecovered">;
    private readonly auditLogService: Pick<AuditLogService, "log">;
    private readonly now: () => Date;

    constructor(deps: FeedHealthMonitorDeps) {
        this.marketDataService = deps.marketDataService;
        this.tradingLoopService = deps.tradingLoopService;
        this.notificationService = deps.notificationService;
        this.auditLogService = deps.auditLogService;
        this.now = deps.now ?? (() => new Date());
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
        logger.info("FeedHealthMonitor started");
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.running = false;
    }

    isRunning(): boolean {
        return this.running;
    }

    /** Exposed for tests; runs the same staleness check the interval fires. */
    checkForTest(): void {
        this.check();
    }

    private check(): void {
        const now = this.now();

        // Roll the session forward when the IST market day changes; a new market
        // day resets everything. Cross-session start is AutoTradingService's job,
        // so we do not (re)start the loop here.
        const istKey = new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
        if (istKey !== this.sessionKey) {
            this.sessionKey = istKey;
            this.sawFreshThisSession = false;
            this.halted = false;
        }

        if (!isIndianMarketHours(now)) return;

        const symbols = this.marketDataService.getTrackedSymbols();
        if (symbols.length === 0) return;

        let latestMs = -Infinity;
        for (const symbol of symbols) {
            const timestamp = this.marketDataService.getTick(symbol)?.timestamp?.getTime();
            if (typeof timestamp === "number" && timestamp > latestMs) {
                latestMs = timestamp;
            }
        }
        if (latestMs === -Infinity) return;

        const ageMs = now.getTime() - latestMs;

        if (ageMs <= STALENESS_TIMEOUT_MS) {
            this.sawFreshThisSession = true;
            if (this.halted) {
                this.halted = false;
                this.tradingLoopService.start();
                void this.notificationService.notifyFeedRecovered();
                void this.auditLogService.log("SYSTEM_DEFAULT", {
                    eventType: "SYSTEM",
                    category: "system",
                    message: "Feed recovered; trading auto-resumed",
                    severity: "info",
                });
            }
            return;
        }

        // ageMs > STALENESS_TIMEOUT_MS
        if (this.sawFreshThisSession && !this.halted) {
            this.halted = true;

            this.tradingLoopService.stop();

            const ageSeconds = Math.round(ageMs / 1000);
            void this.notificationService.notifyCriticalError(
                "FEED_STALENESS",
                `No market ticks for ${ageSeconds}s during market hours — trading halted`
            );
            void this.auditLogService.log("SYSTEM_DEFAULT", {
                eventType: "FEED_STALENESS",
                category: "system",
                message: `Feed stale for ${ageSeconds}s; halted`,
                details: { ageSeconds },
                severity: "error",
            });
            logger.error({ ageSeconds }, "Market data feed stale — trading halted");
        }
        // else: !sawFreshThisSession → the feed hasn't ticked yet this session,
        // which is normal right at open and on weekday exchange holidays.
    }
}

export default FeedHealthMonitor;
