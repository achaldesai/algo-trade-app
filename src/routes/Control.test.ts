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

const mockTradingEngine = {
    sellAllPositions: mock.fn(async () => ({ executions: [], failures: [] })),
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
    });
});
