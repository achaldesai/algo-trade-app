import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import { ReconciliationService } from "./ReconciliationService";

describe("ReconciliationService", () => {
    let mockBroker: any;
    let mockPortfolioService: any;
    let service: ReconciliationService;

    beforeEach(() => {
        mockBroker = {
            isConnected: mock.fn(() => true),
            getPositions: mock.fn(() => Promise.resolve([])),
            connect: mock.fn(),
        };
        mockPortfolioService = {
            getTradeSummaries: mock.fn(() => Promise.resolve([])),
            recordExternalTrade: mock.fn(),
        };
        service = new ReconciliationService(mockBroker, mockPortfolioService);
    });

    it("should reconcile with no discrepancies when empty", async () => {
        const result = await service.reconcilePeriodic();
        assert.strictEqual(result.hasDiscrepancies, false);
        assert.strictEqual(result.discrepancies.length, 0);
    });

    it("should detect discrepancy when broker has position but local does not", async () => {
        mockBroker.getPositions.mock.mockImplementation(() => Promise.resolve([
            { symbol: "AAPL", side: "BUY", quantity: 10, price: 150 }
        ]));

        const result = await service.reconcilePeriodic();
        assert.strictEqual(result.hasDiscrepancies, true);
        assert.strictEqual(result.discrepancies.length, 1);
        assert.strictEqual(result.discrepancies[0].symbol, "AAPL");
        assert.strictEqual(result.discrepancies[0].action, "SYNC_FROM_BROKER");
    });
});
