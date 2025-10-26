import type {
  PortfolioTarget,
  RebalanceResult,
  BrokerOrderRequest,
  PortfolioSnapshot,
  MarketTick
} from "../types";
import type BrokerClient from "../brokers/BrokerClient";
import logger from "../utils/logger";

export interface PortfolioAllocation {
  symbol: string;
  targetWeight: number;
  minWeight?: number;
  maxWeight?: number;
}

export interface RebalanceOptions {
  totalPortfolioValue: number;
  driftThreshold: number; // Percentage (e.g., 0.05 for 5%)
  minTradeValue: number; // Minimum trade size to execute
  cashReserveRatio: number; // Percentage to keep as cash (e.g., 0.05 for 5%)
}

export class PortfolioRebalancer {
  private readonly defaultOptions: RebalanceOptions = {
    totalPortfolioValue: 100000, // $100k default
    driftThreshold: 0.05, // 5% drift before rebalancing
    minTradeValue: 1000, // $1k minimum trade
    cashReserveRatio: 0.05, // 5% cash reserve
  };

  async calculateRebalance(
    targetAllocations: PortfolioAllocation[],
    currentPortfolio: PortfolioSnapshot,
    currentPrices: MarketTick[],
    options: Partial<RebalanceOptions> = {}
  ): Promise<RebalanceResult> {
    const opts = { ...this.defaultOptions, ...options };
    const priceMap = new Map(currentPrices.map(tick => [tick.symbol, tick.price]));

    // Calculate current portfolio value
    const currentValue = this.calculatePortfolioValue(currentPortfolio, priceMap);
    const availableCash = opts.totalPortfolioValue - currentValue;
    const targetCash = opts.totalPortfolioValue * opts.cashReserveRatio;
    const investableAmount = opts.totalPortfolioValue - targetCash;

    logger.info({
      currentValue,
      availableCash,
      targetCash,
      investableAmount
    }, "Portfolio rebalance calculation started");

    // Validate allocations
    this.validateAllocations(targetAllocations);

    // Calculate targets
    const targets: PortfolioTarget[] = [];
    let totalCashRequired = 0;

    for (const allocation of targetAllocations) {
      const currentPosition = currentPortfolio.positions.find(p => p.symbol === allocation.symbol);
      const currentQuantity = currentPosition?.netQuantity || 0;
      const currentPrice = priceMap.get(allocation.symbol);

      if (!currentPrice) {
        logger.warn({ symbol: allocation.symbol }, "No current price available, skipping");
        continue;
      }

      const targetValue = investableAmount * allocation.targetWeight;
      const targetQuantity = Math.floor(targetValue / currentPrice);
      const requiredQuantity = targetQuantity - currentQuantity;

      const currentWeight = currentValue > 0 ?
        (currentQuantity * currentPrice) / currentValue : 0;
      const targetWeight = allocation.targetWeight;
      const drift = Math.abs(currentWeight - targetWeight);

      let rebalanceAction: "BUY" | "SELL" | "HOLD" = "HOLD";

      if (drift > opts.driftThreshold) {
        if (requiredQuantity > 0) {
          const tradeValue = requiredQuantity * currentPrice;
          if (tradeValue >= opts.minTradeValue) {
            rebalanceAction = "BUY";
            totalCashRequired += tradeValue;
          }
        } else if (requiredQuantity < 0) {
          const tradeValue = Math.abs(requiredQuantity) * currentPrice;
          if (tradeValue >= opts.minTradeValue) {
            rebalanceAction = "SELL";
            totalCashRequired -= tradeValue;
          }
        }
      }

      targets.push({
        symbol: allocation.symbol,
        targetWeight: allocation.targetWeight,
        targetQuantity,
        currentQuantity,
        requiredQuantity: rebalanceAction === "HOLD" ? 0 : requiredQuantity,
        rebalanceAction,
      });
    }

    // Generate orders
    const ordersToExecute = targets
      .filter(target => target.rebalanceAction !== "HOLD")
      .map(target => this.createOrderFromTarget(target, priceMap.get(target.symbol)!));

    logger.info({
      targetsCount: targets.length,
      ordersCount: ordersToExecute.length,
      totalCashRequired
    }, "Rebalance calculation completed");

    return {
      targets,
      totalValue: currentValue,
      cashRequired: totalCashRequired,
      ordersToExecute,
    };
  }

  async executeRebalance(
    rebalanceResult: RebalanceResult,
    broker: BrokerClient
  ): Promise<{ executed: number; failed: number; errors: string[] }> {
    const errors: string[] = [];
    let executed = 0;
    let failed = 0;

    for (const order of rebalanceResult.ordersToExecute) {
      try {
        await broker.placeOrder(order);
        executed++;
        logger.info({ symbol: order.symbol, side: order.side, quantity: order.quantity }, "Rebalance order executed");
      } catch (error) {
        failed++;
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        errors.push(`${order.symbol} ${order.side}: ${errorMsg}`);
        logger.error({ err: error, order }, "Failed to execute rebalance order");
      }
    }

    return { executed, failed, errors };
  }

  private calculatePortfolioValue(portfolio: PortfolioSnapshot, priceMap: Map<string, number>): number {
    return portfolio.positions.reduce((total, position) => {
      const price = priceMap.get(position.symbol) || 0;
      return total + (position.netQuantity * price);
    }, 0);
  }

  private validateAllocations(allocations: PortfolioAllocation[]): void {
    const totalWeight = allocations.reduce((sum, alloc) => sum + alloc.targetWeight, 0);

    if (Math.abs(totalWeight - 1.0) > 0.001) {
      throw new Error(`Portfolio allocations must sum to 1.0, got ${totalWeight.toFixed(3)}`);
    }

    for (const allocation of allocations) {
      if (allocation.targetWeight < 0 || allocation.targetWeight > 1) {
        throw new Error(`Invalid weight for ${allocation.symbol}: ${allocation.targetWeight}`);
      }

      if (allocation.minWeight && allocation.targetWeight < allocation.minWeight) {
        throw new Error(`Target weight ${allocation.targetWeight} below minimum ${allocation.minWeight} for ${allocation.symbol}`);
      }

      if (allocation.maxWeight && allocation.targetWeight > allocation.maxWeight) {
        throw new Error(`Target weight ${allocation.targetWeight} above maximum ${allocation.maxWeight} for ${allocation.symbol}`);
      }
    }
  }

  private createOrderFromTarget(target: PortfolioTarget, _currentPrice: number): BrokerOrderRequest {
    return {
      symbol: target.symbol,
      side: target.rebalanceAction as "BUY" | "SELL",
      quantity: Math.abs(target.requiredQuantity),
      type: "MARKET",
      tag: `REBAL-${Date.now()}`,
    };
  }

  async getDriftAnalysis(
    targetAllocations: PortfolioAllocation[],
    currentPortfolio: PortfolioSnapshot,
    currentPrices: MarketTick[]
  ): Promise<Array<{ symbol: string; currentWeight: number; targetWeight: number; drift: number }>> {
    const priceMap = new Map(currentPrices.map(tick => [tick.symbol, tick.price]));
    const currentValue = this.calculatePortfolioValue(currentPortfolio, priceMap);

    return targetAllocations.map(allocation => {
      const currentPosition = currentPortfolio.positions.find(p => p.symbol === allocation.symbol);
      const currentQuantity = currentPosition?.netQuantity || 0;
      const currentPrice = priceMap.get(allocation.symbol) || 0;

      const currentWeight = currentValue > 0 ?
        (currentQuantity * currentPrice) / currentValue : 0;
      const drift = currentWeight - allocation.targetWeight;

      return {
        symbol: allocation.symbol,
        currentWeight,
        targetWeight: allocation.targetWeight,
        drift,
      };
    });
  }
}

export default PortfolioRebalancer;