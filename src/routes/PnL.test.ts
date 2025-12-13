import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import { createRequest, createResponse } from "node-mocks-http";
import pnlRouter from "./pnl";
import { setContainer, AppContainer } from "../container";

// Mock data
const mockTrades = [
    {
        id: "t1",
        symbol: "TCS",
        side: "BUY",
        quantity: 10,
        price: 100,
        executedAt: new Date(),
    },
    {
        id: "t2",
        symbol: "TCS",
        side: "SELL",
        quantity: 5,
        price: 110, // Profit 50
        executedAt: new Date(),
    }
];

const mockSnapshot = {
    positions: [
        {
            symbol: "TCS",
            netQuantity: 5,
            averageEntryPrice: 100,
            realizedPnl: 50,
            unrealizedPnl: 0,
            name: "Tata Consultancy Services",
            position: 1000 // Sample value
        }
    ],
    totalTrades: 2,
};

// Mock Dependencies
const mockPortfolioService = {
    listTrades: mock.fn(async () => mockTrades),
    getSnapshot: mock.fn(async () => mockSnapshot),
    getTradeSummaries: mock.fn(async () => mockSnapshot.positions),
    getRealizedPnl: mock.fn(async () => 50),
};

const mockMarketDataService = {
    getTick: mock.fn((symbol: string) => ({ symbol, price: 120 })), // Current price 120
};

const mockRiskManager = {
    getStatus: mock.fn(() => ({ circuitBroken: false })),
};

// Mock Container
const mockContainer = {
    portfolioService: mockPortfolioService,
    marketDataService: mockMarketDataService,
    riskManager: mockRiskManager,
} as unknown as AppContainer;

describe("PnL Routes", () => {
    beforeEach(() => {
        setContainer(mockContainer);
    });

    it("GET /daily should calculate daily PnL correctly", async () => {
        const req = createRequest({ method: "GET", url: "/daily" });
        const res = createResponse();
        const next = mock.fn();

        await pnlRouter(req, res, next);
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.strictEqual(res.statusCode, 200);
        const data = res._getJSONData().data;

        // Realized: Sell 5 @ 110 (Entry 100) = 5 * 10 = 50
        assert.strictEqual(data.summary.realizedPnL, 50);

        // Unrealized: Remaining 5 @ 100, Current Price 120 = 5 * 20 = 100
        assert.strictEqual(data.summary.unrealizedPnL, 100);

        assert.strictEqual(data.summary.totalPnL, 150);
    });

    it("GET /summary should return overall summary", async () => {
        const req = createRequest({ method: "GET", url: "/summary" });
        const res = createResponse();
        const next = mock.fn();

        await pnlRouter(req, res, next);
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.strictEqual(res.statusCode, 200);
        const data = res._getJSONData().data;

        // Based on snapshot + live price
        assert.strictEqual(data.totalRealizedPnL, 50);
        assert.strictEqual(data.totalUnrealizedPnL, 100);
        assert.strictEqual(data.totalPnL, 150);
        assert.strictEqual(data.openPositions, 1);
    });

    it("GET /positions should return positions with live prices", async () => {
        const req = createRequest({ method: "GET", url: "/positions" });
        const res = createResponse();
        const next = mock.fn();

        await pnlRouter(req, res, next);
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.strictEqual(res.statusCode, 200);
        const positions = res._getJSONData().data.positions;

        assert.strictEqual(positions.length, 1);
        assert.strictEqual(positions[0].symbol, "TCS");
        assert.strictEqual(positions[0].currentPrice, 120);
        assert.strictEqual(positions[0].unrealizedPnl, 100);
    });
});
