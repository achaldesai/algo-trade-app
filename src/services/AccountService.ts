import type BrokerClient from "../brokers/BrokerClient";
import type { SettingsRepo } from "../db/repositories/SettingsRepo";
import type { StrategyAccount } from "../strategies/BaseStrategy";
import type PortfolioService from "./PortfolioService";
import logger from "../utils/logger";

export interface AccountServiceDeps {
  portfolioService: PortfolioService;
  settingsRepo: SettingsRepo;
  /** Latest live price for a symbol, if any. */
  priceLookup: (symbol: string) => number | undefined;
}

/**
 * The account balance strategies size orders from (`StrategyContext.account`).
 *
 * - Cash: from the broker's `getFunds()`. The paper broker has no real
 *   balance, so its cash is the user's paper starting cash plus sells minus
 *   buys in their recorded trades.
 * - Equity: cash plus open long positions at the latest price (falling back to
 *   the average entry price).
 *
 * Returns undefined when cash is unknown; callers must then not size buys from
 * equity. There is deliberately no default balance.
 */
export class AccountService {
  constructor(private readonly deps: AccountServiceDeps) {}

  async getAccount(userId: string, broker: BrokerClient): Promise<StrategyAccount | undefined> {
    const cash = await this.getCash(userId, broker);
    if (cash === undefined) return undefined;

    const positions = this.deps.portfolioService
      .getSnapshot(userId)
      .positions.filter((p) => p.netQuantity > 0);
    const invested = positions.reduce(
      (sum, p) => sum + p.netQuantity * (this.deps.priceLookup(p.symbol) ?? p.averageEntryPrice),
      0,
    );
    return { cash, equity: cash + invested };
  }

  private async getCash(userId: string, broker: BrokerClient): Promise<number | undefined> {
    if (broker.name === "paper") {
      let cash = this.deps.settingsRepo.getPaperStartingCash(userId);
      for (const trade of this.deps.portfolioService.listTrades(userId)) {
        cash += (trade.side === "SELL" ? 1 : -1) * trade.price * trade.quantity;
      }
      return cash;
    }
    try {
      const funds = await broker.getFunds?.();
      return funds?.cash;
    } catch (error) {
      logger.warn({ err: error, userId, broker: broker.name }, "Could not read account funds");
      return undefined;
    }
  }
}

export default AccountService;
