import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import { TradingLoopService } from "./TradingLoopService";
import type { MarketDataService } from "./MarketDataService";
import type { TradingEngine } from "./TradingEngine";
import type { StrategyConfigRepo } from "../db/repositories/StrategyConfigRepo";

describe("TradingLoopService", () => {
    let mockMarketDataService: unknown;
    let mockTradingEngine: unknown;
    let mockStrategyConfigRepo: unknown;
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
        mockStrategyConfigRepo = {
            getActiveStrategies: mock.fn(() => []),
            getConfig: mock.fn(() => null),
            getAllConfigs: mock.fn(() => []),
        };
        service = new TradingLoopService(
            mockMarketDataService as MarketDataService,
            mockTradingEngine as TradingEngine,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            {} as any, // Mock UserRepository
            mockStrategyConfigRepo as StrategyConfigRepo
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

    describe("strategy selection per tick", () => {
        const strategies = [
            { id: "vwap", timeframe: "tick" },
            { id: "ma-crossover", timeframe: "1day" },
        ];
        type Config = { strategyId: string; enabled: boolean; params: Record<string, unknown> };

        async function evaluatedFor(configs: Config[]) {
            const evaluate = mock.fn(async (_strategyId: string) => ({}));
            const marketData = { on: mock.fn(), off: mock.fn() };
            const loop = new TradingLoopService(
                marketData as unknown as MarketDataService,
                { getStrategies: () => strategies, evaluate } as unknown as TradingEngine,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                { listUsers: () => [{ id: "u1" }] } as any,
                {
                    getAllConfigs: () => configs,
                    getActiveStrategies: () => configs.filter((c) => c.enabled),
                } as unknown as StrategyConfigRepo,
            );
            loop.start();
            const handler = marketData.on.mock.calls[0].arguments[1] as (t: unknown) => Promise<void>;
            await handler({ symbol: "TCS", price: 1, volume: 1, timestamp: new Date() });
            return evaluate.mock.calls.map((c) => c.arguments[0]);
        }

        it("evaluates only tick strategies when the user has no configs", async () => {
            assert.deepStrictEqual(await evaluatedFor([]), ["vwap"]);
        });

        it("never evaluates daily strategies on ticks, even when enabled", async () => {
            assert.deepStrictEqual(
                await evaluatedFor([{ strategyId: "ma-crossover", enabled: true, params: {} }]),
                [],
                "enabling only a daily strategy must not fall back to running VWAP with defaults",
            );
        });

        it("evaluates nothing when the user disabled every strategy", async () => {
            assert.deepStrictEqual(await evaluatedFor([{ strategyId: "vwap", enabled: false, params: {} }]), []);
        });

        it("evaluates enabled tick strategies with the user's params", async () => {
            assert.deepStrictEqual(
                await evaluatedFor([
                    { strategyId: "vwap", enabled: true, params: { threshold: 0.02 } },
                    { strategyId: "ma-crossover", enabled: true, params: {} },
                ]),
                ["vwap"],
            );
        });
    });
});
