import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HealthService } from "./HealthService";
import type BrokerClient from "../brokers/BrokerClient";
import type { TickerClient } from "./TickerClient";
import type { MarketDataService } from "./MarketDataService";
import type { MarketTick } from "../types";

// 2026-11-16 is a Monday. IST = UTC + 5:30.
const ist = (iso: string) => new Date(`${iso}+05:30`);

function service(opts: { now: Date; tickerConnected: boolean; lastTickAt?: Date }) {
  const ticks: MarketTick[] = opts.lastTickAt
    ? [{ symbol: "TCS", price: 2400, volume: 1, timestamp: opts.lastTickAt }]
    : [];
  return new HealthService({
    brokerClient: { name: "paper", isConnected: () => true } as unknown as BrokerClient,
    tickerClient: { isConnected: () => opts.tickerConnected } as unknown as TickerClient,
    marketDataService: { getSnapshot: () => ({ ticks, asOf: opts.now }) } as unknown as MarketDataService,
    now: () => opts.now,
  });
}

const ticker = async (s: HealthService) => {
  const health = await s.getHealth();
  return { overall: health.status, ...health.components.find((c) => c.name === "ticker")! };
};

describe("HealthService ticker check", () => {
  it("treats a disconnected ticker as idle, not unhealthy, outside market hours", async () => {
    for (const now of [ist("2026-11-15T22:15:00"), ist("2026-11-16T08:00:00"), ist("2026-11-16T16:00:00"), ist("2026-11-14T11:00:00")]) {
      const t = await ticker(service({ now, tickerConnected: false }));
      assert.equal(t.status, "healthy", now.toISOString());
      assert.match(t.message!, /^Idle: market closed/);
      assert.notEqual(t.overall, "unhealthy", "the system isn't unhealthy just because the market is closed");
    }
  });

  it("is unhealthy when disconnected during market hours", async () => {
    const t = await ticker(service({ now: ist("2026-11-16T11:00:00"), tickerConnected: false }));
    assert.deepEqual([t.status, t.message, t.overall], ["unhealthy", "Disconnected", "unhealthy"]);
  });

  it("is degraded when connected but the last tick is over 60s old (unchanged)", async () => {
    const now = ist("2026-11-16T11:00:00");
    const stale = await ticker(service({ now, tickerConnected: true, lastTickAt: new Date(now.getTime() - 90_000) }));
    assert.equal(stale.status, "degraded");
    const fresh = await ticker(service({ now, tickerConnected: true, lastTickAt: new Date(now.getTime() - 5_000) }));
    assert.equal(fresh.status, "healthy");
    assert.match(fresh.message!, /last tick 5s ago/);
  });
});

describe("HealthService memory", () => {
  it("reports RSS and heap against V8's heap limit, not heapTotal", async () => {
    const { memory } = await service({ now: ist("2026-11-16T11:00:00"), tickerConnected: true }).getHealth();
    assert.ok(memory.rssMB > 0);
    assert.ok(memory.heapLimitMB > memory.heapUsedMB, "the limit is far above what an idle test process uses");
    assert.ok(memory.heapPercentOfLimit > 0 && memory.heapPercentOfLimit < 50, `heap ${memory.heapPercentOfLimit}%`);
  });
});
