import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import { createRequest, createResponse, type RequestMethod } from "node-mocks-http";
import express from "express";
import { EventEmitter, once } from "node:events";
import controlRouter from "./control";
import errorHandler from "../middleware/errorHandler";
import type { AppContainer } from "../container";
import env from "../config/env";

env.adminApiKey = "test-key";

// Mock dependencies
const mockLoopService = {
    start: mock.fn(),
    stop: mock.fn(),
    getStatus: mock.fn(() => ({ running: true, mode: "parallel", stopLoss: { monitoring: true, activeCount: 5 } })),
};

const mockStopLossMonitor = {
    start: mock.fn(),
    stop: mock.fn(),
    getStatus: mock.fn(() => ({ monitoring: true, activeStopLosses: 5 })),
};

type PanicResult = { openPositions: number; closed: string[]; executions: unknown[]; failures: { request: { symbol: string; side: string; quantity: number }; error: string }[]; notes: string[] };
let panicResult: PanicResult = { openPositions: 2, closed: ["TCS", "INFY"], executions: [{}, {}], failures: [], notes: [] };
const mockTradingEngine = {
    sellAllPositions: mock.fn(async () => panicResult),
};

const mockStopLossRepo = {
    delete: mock.fn(async () => undefined),
};

let autoStart = { enabled: false, manuallyStopped: false };
const mockAutoTrading = {
    markManualStop: mock.fn(() => { autoStart = { ...autoStart, manuallyStopped: true }; }),
    clearManualStop: mock.fn(() => { autoStart = { ...autoStart, manuallyStopped: false }; }),
    getAutoStartStatus: mock.fn(() => autoStart),
};
const mockSettingsRepo = {
    saveAutoStartTrading: mock.fn(async (enabled: boolean) => { autoStart = { ...autoStart, enabled }; }),
};

const mockUserRepo = {
    listUsers: mock.fn(() => [{ id: "test-panic-user", username: "test_panic_user", role: "USER" }]),
};

// Partial mock container
const mockContainer = {
    tradingEngine: mockTradingEngine,
    stopLossMonitor: mockStopLossMonitor,
    tradingLoopService: mockLoopService,
    userRepo: mockUserRepo,
    stopLossRepo: mockStopLossRepo,
    autoTradingService: mockAutoTrading,
    settingsRepo: mockSettingsRepo,
    dailyStrategyRunner: {
        getStatus: () => ({ scheduled: true, nextRunAt: "2026-11-09T09:45:00.000Z", lastRun: null }),
    },
} as unknown as AppContainer;

const testApp = express();
testApp.use(express.json());
testApp.locals.container = mockContainer;
testApp.use("/api/control", controlRouter);
testApp.use(errorHandler);

interface RequestOptions {
    method: RequestMethod;
    url: string;
    body?: unknown;
    headers?: Record<string, string>;
}

const invokeApp = async ({ method, url, body, headers }: RequestOptions) => {
    const req = createRequest({
        method,
        url,
        headers: {
            "content-type": "application/json",
            ...headers,
        },
    });

    if (typeof body !== "undefined") {
        req.body = body;
    }

    const res = createResponse({ eventEmitter: EventEmitter });
    const waitForEnd = once(res, "end");
    testApp(req, res);
    req.emit("end");

    await waitForEnd;
    return res;
};

describe("Control Routes", () => {
    beforeEach(() => {
        mockLoopService.start.mock.resetCalls();
        mockLoopService.stop.mock.resetCalls();
        mockStopLossMonitor.start.mock.resetCalls();
        mockStopLossMonitor.stop.mock.resetCalls();
        mockTradingEngine.sellAllPositions.mock.resetCalls();
        mockStopLossRepo.delete.mock.resetCalls();
        mockAutoTrading.markManualStop.mock.resetCalls();
        mockAutoTrading.clearManualStop.mock.resetCalls();
        autoStart = { enabled: false, manuallyStopped: false };
        panicResult = { openPositions: 2, closed: ["TCS", "INFY"], executions: [{}, {}], failures: [], notes: [] };
    });

    it("GET /status should return combined status", async () => {
        const res = await invokeApp({
            method: "GET",
            url: "/api/control/status",
            headers: { "x-admin-api-key": "test-key" },
        });

        assert.strictEqual(res.statusCode, 200);
        const data = res._getJSONData();
        assert.strictEqual(data.running, true);
        assert.strictEqual(data.stopLoss.monitoring, true);
        assert.strictEqual(data.stopLoss.activeCount, 5);
        assert.strictEqual(data.dailyStrategies.nextRunAt, "2026-11-09T09:45:00.000Z");
    });

    it("POST /start should start loop and monitor", async () => {
        const res = await invokeApp({
            method: "POST",
            url: "/api/control/start",
            headers: { "x-admin-api-key": "test-key" },
        });

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(mockLoopService.start.mock.callCount(), 1);
        assert.strictEqual(mockStopLossMonitor.start.mock.callCount(), 1);
    });

    it("POST /stop should stop loop and monitor", async () => {
        const res = await invokeApp({
            method: "POST",
            url: "/api/control/stop",
            headers: { "x-admin-api-key": "test-key" },
        });

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(mockLoopService.stop.mock.callCount(), 1);
        assert.strictEqual(mockStopLossMonitor.stop.mock.callCount(), 1);
    });

    it("STOP and panic sell hold trading off against auto-start; START clears that", async () => {
        const admin = { "x-admin-api-key": "test-key" };
        await invokeApp({ method: "POST", url: "/api/control/stop", headers: admin });
        assert.strictEqual(mockAutoTrading.markManualStop.mock.callCount(), 1);
        await invokeApp({ method: "POST", url: "/api/control/panic-sell", body: { confirmToken: "PANIC-CONFIRM" }, headers: admin });
        assert.strictEqual(mockAutoTrading.markManualStop.mock.callCount(), 2);
        await invokeApp({ method: "POST", url: "/api/control/start", headers: admin });
        assert.strictEqual(mockAutoTrading.clearManualStop.mock.callCount(), 1);
        assert.deepStrictEqual(autoStart, { enabled: false, manuallyStopped: false });
    });

    it("GET/PUT /auto-start reads and saves the setting (admin only), and status shows it", async () => {
        const admin = { "x-admin-api-key": "test-key" };
        let res = await invokeApp({ method: "GET", url: "/api/control/auto-start", headers: admin });
        assert.deepStrictEqual(res._getJSONData().data, { enabled: false, manuallyStopped: false });

        res = await invokeApp({ method: "PUT", url: "/api/control/auto-start", body: { enabled: true }, headers: admin });
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res._getJSONData().data, { enabled: true, manuallyStopped: false });
        assert.deepStrictEqual(mockSettingsRepo.saveAutoStartTrading.mock.calls.at(-1)!.arguments, [true]);

        res = await invokeApp({ method: "PUT", url: "/api/control/auto-start", body: { enabled: "yes" }, headers: admin });
        assert.strictEqual(res.statusCode, 400);

        res = await invokeApp({ method: "PUT", url: "/api/control/auto-start", body: { enabled: false } });
        assert.notStrictEqual(res.statusCode, 200, "needs admin");

        res = await invokeApp({ method: "GET", url: "/api/control/status", headers: admin });
        assert.deepStrictEqual(res._getJSONData().autoStart, { enabled: true, manuallyStopped: false });
    });

    it("POST /panic-sell should fail without confirmation token", async () => {
        const res = await invokeApp({
            method: "POST",
            url: "/api/control/panic-sell",
            body: {},
            headers: { "x-admin-api-key": "test-key" },
        });

        assert.strictEqual(res.statusCode, 400);
        assert.match(res._getJSONData().message, /Invalid confirmation/);
        assert.strictEqual(mockTradingEngine.sellAllPositions.mock.callCount(), 0);
    });

    it("POST /panic-sell should execute with valid token", async () => {
        const res = await invokeApp({
            method: "POST",
            url: "/api/control/panic-sell",
            body: { confirmToken: "PANIC-CONFIRM" },
            headers: { "x-admin-api-key": "test-key" },
        });

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(mockLoopService.stop.mock.callCount(), 1);
        assert.strictEqual(mockStopLossMonitor.stop.mock.callCount(), 1);
        // One user in mock, so sellAllPositions should be called once
        assert.strictEqual(mockTradingEngine.sellAllPositions.mock.callCount(), 1);
        const body = res._getJSONData();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.message, "Panic sell: closed 2 of 2 open positions");
        assert.deepStrictEqual(
            mockStopLossRepo.delete.mock.calls.map((c) => c.arguments),
            [["test-panic-user", "TCS"], ["test-panic-user", "INFY"]],
            "stop-losses of closed positions are removed",
        );
    });

    it("POST /panic-sell is not a success when a position could not be closed", async () => {
        panicResult = {
            openPositions: 2,
            closed: ["TCS"],
            executions: [{}],
            failures: [{ request: { symbol: "INFY", side: "SELL", quantity: 10 }, error: "no price" }],
            notes: [],
        };
        const res = await invokeApp({
            method: "POST",
            url: "/api/control/panic-sell",
            body: { confirmToken: "PANIC-CONFIRM" },
            headers: { "x-admin-api-key": "test-key" },
        });
        assert.strictEqual(res.statusCode, 207);
        const body = res._getJSONData();
        assert.strictEqual(body.success, false);
        assert.strictEqual(body.message, "Panic sell: closed 1 of 2 open positions, 1 failed");
        assert.deepStrictEqual(body.data.users["test-panic-user"].failures, [{ symbol: "INFY", side: "SELL", quantity: 10, error: "no price" }]);
    });
});
