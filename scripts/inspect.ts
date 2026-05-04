import { DatabaseManager } from "../src/db/DatabaseManager";
import { PortfolioRepo } from "../src/db/repositories/PortfolioRepo";
import env from "../src/config/env";

const USER_ID = "INSPECT_SCRIPT";

const main = async () => {
  const dbManager = new DatabaseManager(env.portfolioStorePath);
  await dbManager.open();
  const repo = new PortfolioRepo(dbManager);

  const stocksBefore = await repo.listStocks(USER_ID);
  console.log("before", stocksBefore);

  // Clear stocks for this user
  const { stocks } = dbManager.handles;
  for (const { key } of stocks.getRange({
    start: `${USER_ID}:`,
    end: `${USER_ID};\uffff`,
  })) {
    await stocks.remove(key);
  }
  const stocksAfterReset = await repo.listStocks(USER_ID);
  console.log("after reset", stocksAfterReset);

  const created = await repo.createStock(USER_ID, {
    symbol: "ZZZZ",
    name: "Test",
    createdAt: new Date(),
  });
  console.log("created", created);

  const stocksFinal = await repo.listStocks(USER_ID);
  console.log("final", stocksFinal);

  await dbManager.close();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
