import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FeedHealthMonitor } from "./FeedHealthMonitor";

// Tuesday 2026-10-06, 10:00 IST — a weekday within market hours (09:15–15:30).
const MARKET_HOURS_NOW = new Date("2026-10-06T10:00:00+05:30");
// Saturday 2026-10-10, 10:00 IST — weekend.
const SATURDAY_NOW = new Date("2026-10-10T10:00:00+05:30");
// Tuesday 2026-10-06, 08:00 IST — weekday but before market open.
const PRE_MARKET_NOW = new Date("2026-10-06T08:00:00+05:30");

interface TickLike {
    symbol: string;
    price: number;
    volume: number;
    timestamp: Date;
}

function makeTick(symbol: string, timestamp: Date): TickLike {
    return { symbol, price: 100, volume: 1, timestamp };
}

function createHarness(initialNow: Date) {
    const ticks = new Map<string, TickLike>();
    const calls = {
        loopStop: 0,
        loopStart: 0,
        notifyCritical: 0,
        notifyRecovered: 0,
        audit: 0,
    };
    let currentTime = initialNow;

    const marketDataService = {
        getTrackedSymbols: () => Array.from(ticks.keys()),
        getTick: (symbol: string) => ticks.get(symbol.toUpperCase()),
    };
    const tradingLoopService = {
        stop: () => { calls.loopStop++; },
        start: () => { calls.loopStart++; },
    };
    const notificationService = {
        notifyCriticalError: async () => { calls.notifyCritical++; },
        notifyFeedRecovered: async () => { calls.notifyRecovered++; },
    };
    const auditLogService = {
        log: async () => { calls.audit++; },
    };

    const monitor = new FeedHealthMonitor({
        marketDataService,
        tradingLoopService,
        notificationService,
        auditLogService,
        now: () => currentTime,
    });

    return {
        ticks,
        calls,
        monitor,
        setNow: (d: Date) => { currentTime = d; },
    };
}

describe("FeedHealthMonitor", () => {
    it("does not halt on a fresh tick during market hours", () => {
        const { ticks, calls, monitor } = createHarness(MARKET_HOURS_NOW);
        ticks.set("RELIANCE", makeTick("RELIANCE", new Date(MARKET_HOURS_NOW.getTime())));

        monitor.checkForTest();

        assert.equal(calls.loopStop, 0);
        assert.equal(calls.notifyCritical, 0);
        assert.equal(calls.notifyRecovered, 0);
        assert.equal(calls.audit, 0);
    });

    it("halts trading and alerts once when all ticks go stale after a fresh tick this session", () => {
        const { ticks, calls, monitor, setNow } = createHarness(MARKET_HOURS_NOW);
        ticks.set("RELIANCE", makeTick("RELIANCE", new Date(MARKET_HOURS_NOW.getTime())));

        // First see a fresh tick this session.
        monitor.checkForTest();
        assert.equal(calls.loopStop, 0);

        // Advance the clock so that same (now-old) tick is stale.
        setNow(new Date(MARKET_HOURS_NOW.getTime() + 60_000));
        monitor.checkForTest();

        assert.equal(calls.loopStop, 1);
        assert.equal(calls.notifyCritical, 1);
        assert.equal(calls.audit, 1);
    });

    it("counts a staleness episode once while the feed stays stale", () => {
        const { ticks, calls, monitor, setNow } = createHarness(MARKET_HOURS_NOW);
        ticks.set("RELIANCE", makeTick("RELIANCE", new Date(MARKET_HOURS_NOW.getTime())));

        monitor.checkForTest();
        setNow(new Date(MARKET_HOURS_NOW.getTime() + 60_000));

        monitor.checkForTest();
        monitor.checkForTest();
        monitor.checkForTest();

        assert.equal(calls.loopStop, 1);
        assert.equal(calls.notifyCritical, 1);
        assert.equal(calls.audit, 1);
    });

    it("auto-resumes and notifies recovery on a fresh tick after halt", () => {
        const { ticks, calls, monitor, setNow } = createHarness(MARKET_HOURS_NOW);
        ticks.set("RELIANCE", makeTick("RELIANCE", new Date(MARKET_HOURS_NOW.getTime())));

        monitor.checkForTest();
        setNow(new Date(MARKET_HOURS_NOW.getTime() + 60_000));
        monitor.checkForTest();

        assert.equal(calls.loopStop, 1);
        assert.equal(calls.notifyCritical, 1);

        // Feed recovers: a fresh tick arrives at the advanced clock.
        ticks.set("RELIANCE", makeTick("RELIANCE", new Date(MARKET_HOURS_NOW.getTime() + 60_000)));
        monitor.checkForTest();

        assert.equal(calls.loopStart, 1);
        assert.equal(calls.notifyRecovered, 1);
        assert.equal(calls.audit, 2); // halt + recovery
        assert.equal(calls.loopStop, 1); // no additional stop
        assert.equal(calls.notifyCritical, 1); // no additional critical alert
    });

    it("does not halt at market open with only yesterday's stale tick", () => {
        const { ticks, calls, monitor } = createHarness(MARKET_HOURS_NOW);
        // Yesterday's cached tick, still present at open; no fresh tick this session yet.
        const yesterday = new Date(MARKET_HOURS_NOW.getTime() - 24 * 60 * 60 * 1000);
        ticks.set("RELIANCE", makeTick("RELIANCE", yesterday));

        monitor.checkForTest();

        assert.equal(calls.loopStop, 0);
        assert.equal(calls.notifyCritical, 0);
        assert.equal(calls.audit, 0);
    });

    it("does not halt on a weekday exchange holiday with only yesterday's stale tick", () => {
        // Wednesday 2026-10-07, 10:30 IST — a weekday in market hours, but the
        // exchange is closed (holiday); only yesterday's cached tick exists.
        const holidayNow = new Date("2026-10-07T10:30:00+05:30");
        const { ticks, calls, monitor } = createHarness(holidayNow);
        const yesterday = new Date(holidayNow.getTime() - 24 * 60 * 60 * 1000);
        ticks.set("RELIANCE", makeTick("RELIANCE", yesterday));

        monitor.checkForTest();

        assert.equal(calls.loopStop, 0);
        assert.equal(calls.notifyCritical, 0);
        assert.equal(calls.audit, 0);
    });

    it("does not halt outside market hours (weekend)", () => {
        const { ticks, calls, monitor } = createHarness(SATURDAY_NOW);
        ticks.set("RELIANCE", makeTick("RELIANCE", new Date(SATURDAY_NOW.getTime() - 60_000)));

        monitor.checkForTest();

        assert.equal(calls.loopStop, 0);
        assert.equal(calls.notifyCritical, 0);
        assert.equal(calls.audit, 0);
    });

    it("does not halt outside market hours (before open)", () => {
        const { ticks, calls, monitor } = createHarness(PRE_MARKET_NOW);
        ticks.set("RELIANCE", makeTick("RELIANCE", new Date(PRE_MARKET_NOW.getTime() - 60_000)));

        monitor.checkForTest();

        assert.equal(calls.loopStop, 0);
        assert.equal(calls.notifyCritical, 0);
        assert.equal(calls.audit, 0);
    });

    it("does not halt when no symbols are tracked", () => {
        const { calls, monitor } = createHarness(MARKET_HOURS_NOW);

        monitor.checkForTest();

        assert.equal(calls.loopStop, 0);
        assert.equal(calls.notifyCritical, 0);
        assert.equal(calls.audit, 0);
    });

    it("does not halt when tracked symbols have no timestamps", () => {
        const { ticks, calls, monitor } = createHarness(MARKET_HOURS_NOW);
        ticks.set("RELIANCE", { symbol: "RELIANCE", price: 100, volume: 1 } as TickLike);

        monitor.checkForTest();

        assert.equal(calls.loopStop, 0);
        assert.equal(calls.notifyCritical, 0);
        assert.equal(calls.audit, 0);
    });
});
