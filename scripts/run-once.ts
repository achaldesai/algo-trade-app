import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ensurePortfolioStore } from "../src/persistence";
import { resetContainer } from "../src/container";
import type { MarketTick } from "../src/types";

interface CliOptions {
  strategyId: string;
  ticksPath?: string;
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = { strategyId: "vwap" };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--strategy" && index + 1 < argv.length) {
      options.strategyId = argv[index + 1];
      index += 1;
      continue;
    }

    if (current === "--ticks" && index + 1 < argv.length) {
      options.ticksPath = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return options;
};

const loadTicks = async (ticksPath: string | undefined): Promise<MarketTick[]> => {
  if (!ticksPath) {
    return [];
  }

  const absolute = path.resolve(process.cwd(), ticksPath);
  const payload = await readFile(absolute, "utf-8");
  const parsed = JSON.parse(payload);

  if (!Array.isArray(parsed)) {
    throw new Error("Ticks file must contain an array of tick objects");
  }

  return parsed.map((entry) => ({
    symbol: String(entry.symbol ?? "").toUpperCase(),
    price: Number(entry.price ?? 0),
    volume: Number(entry.volume ?? 0),
    timestamp: new Date(entry.timestamp ?? Date.now()),
  } satisfies MarketTick));
};

const replacer = (_key: string, value: unknown) => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  await ensurePortfolioStore();

  const container = resetContainer();
  const ticks = await loadTicks(options.ticksPath);

  if (ticks.length > 0) {
    const marketData = container.marketDataService;
    for (const tick of ticks) {
      marketData.updateTick(tick);
    }
  }

  const result = await container.tradingEngine.evaluate(options.strategyId);
  console.log(JSON.stringify(result, replacer, 2));
};

main().catch((error) => {
  console.error("Failed to execute strategy", error);
  process.exit(1);
});
