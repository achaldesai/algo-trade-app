import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import { TradingLoopService } from "./TradingLoopService";
import type { MarketDataService } from "./MarketDataService";
import type { TradingEngine } from "./TradingEngine";

describe("TradingLoopService", () => {
    let mockMarketDataService: unknown;
    let mockTradingEngine: unknown;
    let service: TradingLoopService;

    beforeEach(() => {
        mockMarketDataService = {
            on: mock.fn(),
            off: mock.fn(),
        };
        mockTradingEngine = {
            getStrategies: mock.fn(() => []),
            evaluate: mock.fn(),
        };
        // Reset instance for testing
        // @ts-expect-error - Internal instance reset for testing
        TradingLoopService.instance = undefined;
        service = new TradingLoopService(
            mockMarketDataService as MarketDataService,
            mockTradingEngine as TradingEngine
        );
    });

    it("should start and stop correctly", () => {
        service.start();
        assert.strictEqual(service.getStatus().running, true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.strictEqual((mockMarketDataService as any).on.mock.callCount(), 1);

        service.stop();
        assert.strictEqual(service.getStatus().running, false);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.strictEqual((mockMarketDataService as any).off.mock.callCount(), 1);
    });

    it("should set evaluation mode", () => {
        service.setEvaluationMode("sequential");
        assert.strictEqual(service.getStatus().mode, "sequential");

        service.setEvaluationMode("parallel");
        assert.strictEqual(service.getStatus().mode, "parallel");
    });
});
