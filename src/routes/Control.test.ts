import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import { createRequest, createResponse, type RequestMethod } from "node-mocks-http";
import express from "express";
import { EventEmitter, once } from "node:events";
import controlRouter from "./control";
import errorHandler from "../middleware/errorHandler";
import { TradingLoopService } from "../services/TradingLoopService";
import { setContainer, AppContainer } from "../container";
import * as persistenceModule from "../persistence";

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

const mockBroker = {
    isConnected: mock.fn(() => true),
    connect: mock.fn(async () => { }),
};

const mockTradingEngine = {
    sellAllPositions: mock.fn(async () => ({ executions: [], failures: [] })),
    getActiveBroker: mock.fn(() => mockBroker),
};

// Partial mock container
const mockContainer = {
    tradingEngine: mockTradingEngine,
    stopLossMonitor: mockStopLossMonitor,
} as unknown as AppContainer;

// Mock TradingLoopService static getInstance
TradingLoopService.getInstance = mock.fn(() => mockLoopService as unknown as TradingLoopService);

const testApp = express();
// Mock admin auth logic just by setting headers, but the router does check env.adminApiKey.
// Since env.adminApiKey is set in this file, we can bypass manually or let real adminAuthMiddleware run
testApp.use(express.json());
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
            ...headers
        }
    });

    if (typeof body !== "undefined") {
        req.body = body;
    }

    const res = createResponse({ eventEmitter: EventEmitter });
    const waitForEnd = once(res, "end");
    testApp(req, res);

    // For sync handlers that don't await, they call res.json right away and emit end.
    // However, fast rendering in express might need req to close.
    // node-mocks-http sometimes requires explicitly ending the request stream.
    req.emit("end");

    await waitForEnd;
    return res;
};

describe("Control Routes", () => {
    beforeEach(async () => {
        setContainer(mockContainer);

        // Ensure at least one test user exists for panic-sell to process
        await persistenceModule.ensureUserStore();
        const userRepo = persistenceModule.getUserRepository();
        try {
            await userRepo.createUser({ username: "test_panic_user", passwordHash: "password", role: "USER" });
        } catch (_e) {
            // Might already exist if tests run in same process
        }
        // Reset mocks
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
            headers: { "x-admin-api-key": "test-key" }
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
            headers: { "x-admin-api-key": "test-key" }
        });

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(mockLoopService.start.mock.callCount(), 1);
        assert.strictEqual(mockStopLossMonitor.start.mock.callCount(), 1);
    });

    it("POST /stop should stop loop and monitor", async () => {
        const res = await invokeApp({
            method: "POST",
            url: "/api/control/stop",
            headers: { "x-admin-api-key": "test-key" }
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
            headers: { "x-admin-api-key": "test-key" }
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
            headers: { "x-admin-api-key": "test-key" }
        });

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(mockLoopService.stop.mock.callCount(), 1);
        assert.strictEqual(mockStopLossMonitor.stop.mock.callCount(), 1);
        const users = await persistenceModule.getUserRepository().listUsers();
        assert.strictEqual(mockTradingEngine.sellAllPositions.mock.callCount(), users.length);
    });
});
