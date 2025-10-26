import { ensurePortfolioStore, resetPortfolioStore, getPortfolioRepository } from "../src/persistence";

const main = async () => {
  await ensurePortfolioStore();
  const repo = getPortfolioRepository();
  const stocksBefore = await repo.listStocks();
  console.log("before", stocksBefore);
  await resetPortfolioStore();
  const stocksAfterReset = await repo.listStocks();
  console.log("after reset", stocksAfterReset);
  const created = await repo.createStock({
    symbol: "ZZZZ",
    name: "Test",
    createdAt: new Date(),
  });
  console.log("created", created);
  const stocksFinal = await repo.listStocks();
  console.log("final", stocksFinal);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
