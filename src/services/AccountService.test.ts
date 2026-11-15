import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccountService } from "./AccountService";
import type BrokerClient from "../brokers/BrokerClient";
import type PortfolioService from "./PortfolioService";
import type { SettingsRepo } from "../db/repositories/SettingsRepo";
import type { PortfolioPositionSnapshot, Trade } from "../types";

const trade = (side: "BUY" | "SELL", quantity: number, price: number): Trade => ({
  id: `${side}-${quantity}-${price}`,
  symbol: "INFY",
  side,
  quantity,
  price,
  executedAt: new Date(),
});

function setup(opts: { trades?: Trade[]; positions?: Partial<PortfolioPositionSnapshot>[]; prices?: Record<string, number> }) {
  return new AccountService({
    portfolioService: {
      listTrades: () => opts.trades ?? [],
      getSnapshot: () => ({ generatedAt: new Date(), totalTrades: 0, positions: opts.positions ?? [] }),
    } as unknown as PortfolioService,
    settingsRepo: { getPaperStartingCash: () => 50_000 } as unknown as SettingsRepo,
    priceLookup: (symbol) => opts.prices?.[symbol],
  });
}

const paper = { name: "paper" } as BrokerClient;
const live = (getFunds?: () => Promise<{ cash: number } | null>) => ({ name: "zerodha", getFunds }) as BrokerClient;

describe("AccountService", () => {
  it("paper: cash is the starting cash plus sells minus buys", async () => {
    const service = setup({
      trades: [trade("BUY", 10, 1000), trade("SELL", 4, 1100)],
      positions: [{ symbol: "INFY", netQuantity: 6, averageEntryPrice: 1000 }],
      prices: { INFY: 1200 },
    });
    // 50,000 - 10,000 + 4,400 = 44,400 cash; 6 x 1,200 held.
    assert.deepEqual(await service.getAccount("u1", paper), { cash: 44_400, equity: 51_600 });
  });

  it("values positions at the entry price when there is no live price, and ignores flat ones", async () => {
    const service = setup({
      positions: [
        { symbol: "TCS", netQuantity: 2, averageEntryPrice: 2400 },
        { symbol: "INFY", netQuantity: 0, averageEntryPrice: 1000 },
      ],
    });
    const account = await service.getAccount("u1", live(async () => ({ cash: 1000 })));
    assert.deepEqual(account, { cash: 1000, equity: 5800 });
  });

  it("live: no account when the broker can't report funds, or throws", async () => {
    const service = setup({});
    assert.equal(await service.getAccount("u1", live()), undefined, "broker without getFunds");
    assert.equal(await service.getAccount("u1", live(async () => null)), undefined);
    assert.equal(
      await service.getAccount("u1", live(async () => {
        throw new Error("network");
      })),
      undefined,
    );
  });
});
