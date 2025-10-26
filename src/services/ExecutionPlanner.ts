import type {
  BrokerOrderRequest,
  ExecutionPlan,
  HistoricalCandle,
  MarketTick
} from "../types";
import type BrokerClient from "../brokers/BrokerClient";
import TechnicalIndicators from "./TechnicalIndicators";
import logger from "../utils/logger";

export interface ExecutionContext {
  marketTick: MarketTick;
  historicalData: HistoricalCandle[];
  averageDailyVolume: number;
  timeOfDay: "MARKET_OPEN" | "MID_DAY" | "MARKET_CLOSE";
}

export interface ExecutionRules {
  maxOrderSizePercent: number; // Max % of average daily volume
  maxMarketImpact: number; // Max estimated price impact %
  preferredSpread: number; // Preferred bid-ask spread %
  twapThreshold: number; // Order value threshold for TWAP
}

export class ExecutionPlanner {
  private readonly defaultRules: ExecutionRules = {
    maxOrderSizePercent: 0.10, // 10% of ADV
    maxMarketImpact: 0.005, // 0.5% price impact
    preferredSpread: 0.002, // 0.2% spread
    twapThreshold: 50000, // $50k threshold for TWAP
  };

  async planExecution(
    orders: BrokerOrderRequest[],
    context: ExecutionContext,
    rules: Partial<ExecutionRules> = {}
  ): Promise<ExecutionPlan> {
    const executionRules = { ...this.defaultRules, ...rules };

    logger.info({ ordersCount: orders.length }, "Planning order execution");

    // Analyze market conditions
    const volatility = TechnicalIndicators.analyzeVolatility(context.historicalData);

    // Calculate total order value
    const totalOrderValue = orders.reduce((sum, order) => {
      const price = order.price || context.marketTick.price;
      return sum + (order.quantity * price);
    }, 0);

    // Assess market impact for each order
    let maxEstimatedImpact = 0;
    for (const order of orders) {
      const volumeRatio = order.quantity / context.averageDailyVolume;
      const estimatedImpact = this.estimateMarketImpact(volumeRatio, volatility.volatility);
      maxEstimatedImpact = Math.max(maxEstimatedImpact, estimatedImpact);
    }

    // Determine execution strategy
    let executionStrategy: ExecutionPlan["executionStrategy"] = "MARKET";
    let recommendedTiming: ExecutionPlan["recommendedTiming"] = "IMMEDIATE";

    // Use LIMIT orders in high volatility
    if (volatility.volatility > 0.3) {
      executionStrategy = "LIMIT";
    }

    // Use TWAP for large orders
    if (totalOrderValue > executionRules.twapThreshold) {
      executionStrategy = "TWAP";
      recommendedTiming = "SPREAD";
    }

    // Delay execution if market impact is too high
    if (maxEstimatedImpact > executionRules.maxMarketImpact) {
      recommendedTiming = "DELAYED";
    }

    // Adjust timing based on market conditions and time of day
    if (context.timeOfDay === "MARKET_OPEN" && volatility.volatility > 0.25) {
      recommendedTiming = "DELAYED"; // Avoid high opening volatility
    }

    // Optimize order pricing for LIMIT orders
    const optimizedOrders = orders.map(order => {
      if (executionStrategy === "LIMIT" && order.type === "MARKET") {
        const limitPrice = this.calculateOptimalLimitPrice(
          order,
          context.marketTick,
          volatility.volatility
        );
        return {
          ...order,
          type: "LIMIT" as const,
          price: limitPrice,
        };
      }
      return order;
    });

    logger.info({
      executionStrategy,
      recommendedTiming,
      maxEstimatedImpact: maxEstimatedImpact.toFixed(4),
      totalOrderValue: totalOrderValue.toFixed(2),
      volatility: volatility.volatility.toFixed(4)
    }, "Execution plan created");

    return {
      orders: optimizedOrders,
      estimatedImpact: maxEstimatedImpact,
      recommendedTiming,
      executionStrategy,
    };
  }

  async executeWithTWAP(
    orders: BrokerOrderRequest[],
    broker: BrokerClient,
    durationMinutes: number = 30,
    sliceCount: number = 6
  ): Promise<{ executed: number; failed: number; errors: string[] }> {
    const sliceDuration = (durationMinutes * 60 * 1000) / sliceCount; // ms per slice
    const errors: string[] = [];
    let executed = 0;
    let failed = 0;

    logger.info({
      ordersCount: orders.length,
      durationMinutes,
      sliceCount,
      sliceDuration
    }, "Starting TWAP execution");

    for (let slice = 0; slice < sliceCount; slice++) {
      const sliceOrders = orders.map(order => ({
        ...order,
        quantity: Math.floor(order.quantity / sliceCount),
        tag: `${order.tag || 'TWAP'}-${slice + 1}/${sliceCount}`,
      }));

      // Execute slice
      for (const order of sliceOrders) {
        try {
          await broker.placeOrder(order);
          executed++;
          logger.debug({
            slice: slice + 1,
            symbol: order.symbol,
            quantity: order.quantity
          }, "TWAP slice executed");
        } catch (error) {
          failed++;
          const errorMsg = error instanceof Error ? error.message : "Unknown error";
          errors.push(`Slice ${slice + 1} - ${order.symbol}: ${errorMsg}`);
          logger.error({ err: error, order, slice }, "TWAP slice execution failed");
        }
      }

      // Wait before next slice (except for the last one)
      if (slice < sliceCount - 1) {
        await new Promise(resolve => setTimeout(resolve, sliceDuration));
      }
    }

    logger.info({ executed, failed, errorsCount: errors.length }, "TWAP execution completed");

    return { executed, failed, errors };
  }

  private estimateMarketImpact(volumeRatio: number, volatility: number): number {
    // Simple market impact model: impact increases with volume ratio and volatility
    // Real implementations would use more sophisticated models
    const baseImpact = Math.sqrt(volumeRatio) * 0.01; // Square root law
    const volatilityAdjustment = volatility * 0.5;
    return baseImpact + volatilityAdjustment;
  }

  private calculateOptimalLimitPrice(
    order: BrokerOrderRequest,
    marketTick: MarketTick,
    volatility: number
  ): number {
    const currentPrice = marketTick.price;
    const spread = currentPrice * Math.max(0.001, volatility * 0.02); // Dynamic spread

    if (order.side === "BUY") {
      // For buy orders, place limit slightly below market
      return Number((currentPrice - spread * 0.5).toFixed(2));
    } else {
      // For sell orders, place limit slightly above market
      return Number((currentPrice + spread * 0.5).toFixed(2));
    }
  }

  getExecutionRecommendations(
    orders: BrokerOrderRequest[],
    context: ExecutionContext
  ): Array<{ symbol: string; recommendation: string; reason: string }> {
    const recommendations: Array<{ symbol: string; recommendation: string; reason: string }> = [];

    const volatility = TechnicalIndicators.analyzeVolatility(context.historicalData);

    for (const order of orders) {
      const orderValue = order.quantity * (order.price || context.marketTick.price);
      const volumeRatio = order.quantity / context.averageDailyVolume;

      let recommendation = "Execute immediately with market order";
      let reason = "Normal market conditions";

      if (volatility.volatility > 0.3) {
        recommendation = "Use limit order with conservative pricing";
        reason = "High volatility detected";
      } else if (volumeRatio > 0.1) {
        recommendation = "Split order using TWAP strategy";
        reason = "Large order relative to average volume";
      } else if (orderValue > 50000) {
        recommendation = "Consider spreading execution over 15-30 minutes";
        reason = "Large order value";
      } else if (context.timeOfDay === "MARKET_OPEN") {
        recommendation = "Wait 15-30 minutes after market open";
        reason = "Opening volatility typically high";
      }

      recommendations.push({
        symbol: order.symbol,
        recommendation,
        reason,
      });
    }

    return recommendations;
  }

  async optimizeOrderSizing(
    targetValue: number,
    currentPrice: number,
    availableCash: number,
    _rules: Partial<ExecutionRules> = {}
  ): Promise<{ quantity: number; value: number; reasoning: string }> {

    const idealQuantity = Math.floor(targetValue / currentPrice);
    const idealValue = idealQuantity * currentPrice;

    // Check cash constraints
    if (idealValue > availableCash) {
      const maxQuantity = Math.floor(availableCash / currentPrice);
      return {
        quantity: maxQuantity,
        value: maxQuantity * currentPrice,
        reasoning: "Limited by available cash"
      };
    }

    return {
      quantity: idealQuantity,
      value: idealValue,
      reasoning: "Optimal sizing achieved"
    };
  }
}

export default ExecutionPlanner;