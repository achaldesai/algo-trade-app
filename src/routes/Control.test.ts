import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import { createRequest, createResponse } from "node-mocks-http";
import controlRouter from "./control";
import { TradingLoopService } from "../services/TradingLoopService";
import { setContainer, AppContainer } from "../container";

// Mock middleware is tricky without mock.module if we rely on imports.
// However, since controlRouter imports middleware directly, we can't easily swap it without mock.module.
// BUT, adminAuthMiddleware checks env.adminApiKey. We can set it to "" or properly configure it.
// The middleware is `adminAuth.ts`.
// If we set env.adminApiKey properly and pass the header, it should work.
// OR we can rely on `mock.module` only for headers? 
// The failure was `mock.module is not a function`. 
// Let's assume we can pass auth. ENV var is imported from `../config/env`.
// If we can't mock middleware, we must satisfy it.

// Let's try to satisfy adminAuthMiddleware by setting env manually if possible?
// `env.ts` usually reads process.env.
// Let's set process.env.ADMIN_API_KEY = "test-key" and send header.

import env from "../config/env";
// @ts-ignore
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

const mockTradingEngine = {
    sellAllPositions: mock.fn(async () => ({ executions: [], failures: [] })),
    getActiveBroker: mock.fn(),
};

// Partial mock container
const mockContainer = {
    tradingEngine: mockTradingEngine,
    stopLossMonitor: mockStopLossMonitor,
} as unknown as AppContainer;

// Mock TradingLoopService static getInstance
TradingLoopService.getInstance = mock.fn(() => mockLoopService as any);

describe("Control Routes", () => {
    beforeEach(() => {
        setContainer(mockContainer);

        // Reset mocks
        mockLoopService.start.mock.resetCalls();
        mockLoopService.stop.mock.resetCalls();
        mockStopLossMonitor.start.mock.resetCalls();
        mockStopLossMonitor.stop.mock.resetCalls();
        mockTradingEngine.sellAllPositions.mock.resetCalls();
    });

    it("GET /status should return combined status", async () => {
        const req = createRequest({
            method: "GET",
            url: "/status",
            headers: { "x-admin-api-key": "test-key" }
        });
        const res = createResponse();
        const next = mock.fn();

        await controlRouter(req, res, next);

        assert.strictEqual(res.statusCode, 200);
        const data = res._getJSONData();
        assert.strictEqual(data.running, true);
        assert.strictEqual(data.stopLoss.monitoring, true);
        assert.strictEqual(data.stopLoss.activeCount, 5);
    });

    it("POST /start should start loop and monitor", async () => {
        const req = createRequest({
            method: "POST",
            url: "/start",
            headers: { "x-admin-api-key": "test-key" }
        });
        const res = createResponse();
        const next = mock.fn();

        await controlRouter(req, res, next);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(mockLoopService.start.mock.callCount(), 1);
        assert.strictEqual(mockStopLossMonitor.start.mock.callCount(), 1);
    });

    it("POST /stop should stop loop and monitor", async () => {
        const req = createRequest({
            method: "POST",
            url: "/stop",
            headers: { "x-admin-api-key": "test-key" }
        });
        const res = createResponse();
        const next = mock.fn();

        await controlRouter(req, res, next);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(mockLoopService.stop.mock.callCount(), 1);
        assert.strictEqual(mockStopLossMonitor.stop.mock.callCount(), 1);
    });

    it("POST /panic-sell should fail without confirmation token", async () => {
        const req = createRequest({
            method: "POST",
            url: "/panic-sell",
            body: {},
            headers: { "x-admin-api-key": "test-key" }
        });
        const res = createResponse();
        const next = mock.fn();

        await controlRouter(req, res, next);

        assert.strictEqual(res.statusCode, 400);
        assert.match(res._getJSONData().message, /Invalid confirmation/);
        assert.strictEqual(mockTradingEngine.sellAllPositions.mock.callCount(), 0);
    });

    it("POST /panic-sell should execute with valid token", async () => {
        const req = createRequest({
            method: "POST",
            url: "/panic-sell",
            body: { confirmToken: "PANIC-CONFIRM" },
            headers: { "x-admin-api-key": "test-key" }
        });
        const res = createResponse();
        const next = mock.fn();

        await controlRouter(req, res, next);

        // Handler is async, ensure we await logic. 
        // Actually controlRouter returns void, but the handler logic is async.
        // We can't easily await the internal handler completion via router call unless we promisify it?
        // OR we just wait a tick?
        // Since panic-sell is async, calling it via router() might return before result if not careful.
        // However, standard testing often just awaits.
        // Let's rely on node-mocks-http EventEmitter if needed, or simply wait small timeout if flaky.
        // For now, assume await works enough or verify mocks.

        // Wait for async execution
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(mockLoopService.stop.mock.callCount(), 1);
        assert.strictEqual(mockStopLossMonitor.stop.mock.callCount(), 1);
        assert.strictEqual(mockTradingEngine.sellAllPositions.mock.callCount(), 1);
    });
});
