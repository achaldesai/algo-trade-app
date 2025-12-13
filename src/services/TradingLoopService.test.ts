import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import { TradingLoopService } from "./TradingLoopService";
import type { MarketDataService } from "./MarketDataService";
import type { TradingEngine } from "./TradingEngine";

describe("TradingLoopService", () => {
    let mockMarketDataService: any;
    let mockTradingEngine: any;
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
        // @ts-ignore
        TradingLoopService.instance = undefined;
        service = new TradingLoopService(mockMarketDataService, mockTradingEngine);
    });

    it("should start and stop correctly", () => {
        service.start();
        assert.strictEqual(service.getStatus().running, true);
        assert.strictEqual(mockMarketDataService.on.mock.callCount(), 1);

        service.stop();
        assert.strictEqual(service.getStatus().running, false);
        assert.strictEqual(mockMarketDataService.off.mock.callCount(), 1);
    });

    it("should set evaluation mode", () => {
        service.setEvaluationMode("sequential");
        assert.strictEqual(service.getStatus().mode, "sequential");

        service.setEvaluationMode("parallel");
        assert.strictEqual(service.getStatus().mode, "parallel");
    });
});
