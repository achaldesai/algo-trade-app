export type TradeSide = "BUY" | "SELL";

export interface Stock {
  symbol: string;
  name: string;
  createdAt: Date;
}

export interface Trade {
  id: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  executedAt: Date;
  notes?: string;
}

export interface TradeSummary {
  symbol: string;
  name: string;
  netQuantity: number;
  averageEntryPrice: number;
  realizedPnl: number;
  position: "LONG" | "SHORT" | "FLAT";
}

export interface BrokerOrderRequest {
  symbol: string;
  side: TradeSide;
  quantity: number;
  type: "MARKET" | "LIMIT";
  price?: number;
  tag?: string;
}

export interface BrokerOrderQuote {
  symbol: string;
  side: TradeSide;
  limitPrice?: number;
  quantity: number;
  validUntil: Date;
}

export interface BrokerOrderExecution {
  id: string;
  request: BrokerOrderRequest;
  status: "FILLED" | "PARTIALLY_FILLED" | "REJECTED";
  filledQuantity: number;
  averagePrice: number;
  executedAt: Date;
  message?: string;
}

export interface BrokerOrderFailure {
  request: BrokerOrderRequest;
  error: string;
  details?: unknown;
}

export interface MarketTick {
  symbol: string;
  price: number;
  volume: number;
  timestamp: Date;
}

export interface MarketSnapshot {
  ticks: MarketTick[];
  asOf: Date;
}

export interface PortfolioPositionSnapshot extends TradeSummary {
  unrealizedPnl: number;
}

export interface PortfolioSnapshot {
  generatedAt: Date;
  positions: PortfolioPositionSnapshot[];
  totalTrades: number;
}

export interface StrategySignal {
  strategyId: string;
  description: string;
  requestedOrders: BrokerOrderRequest[];
}

export interface StrategyExecutionResult {
  signal: StrategySignal;
  executions: BrokerOrderExecution[];
  failures: BrokerOrderFailure[];
}

export interface StrategyEvaluationError {
  stage: "BROKER_CONNECTION" | "SIGNAL_GENERATION" | "EXECUTION";
  message: string;
  details?: unknown;
}

export interface HistoricalCandle {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: Date;
}

export interface HistoricalDataRequest {
  symbol: string;
  interval: "1day" | "1week" | "1month";
  fromDate: Date;
  toDate: Date;
}

export interface TechnicalIndicatorValues {
  sma?: number;
  ema?: number;
  rsi?: number;
  macd?: {
    macd: number;
    signal: number;
    histogram: number;
  };
  bollinger?: {
    upper: number;
    middle: number;
    lower: number;
  };
}

export interface PortfolioTarget {
  symbol: string;
  targetWeight: number;
  targetQuantity: number;
  currentQuantity: number;
  requiredQuantity: number;
  rebalanceAction: "BUY" | "SELL" | "HOLD";
}

export interface RebalanceResult {
  targets: PortfolioTarget[];
  totalValue: number;
  cashRequired: number;
  ordersToExecute: BrokerOrderRequest[];
}

export interface ExecutionPlan {
  orders: BrokerOrderRequest[];
  estimatedImpact: number;
  recommendedTiming: "IMMEDIATE" | "SPREAD" | "DELAYED";
  executionStrategy: "MARKET" | "LIMIT" | "TWAP";
}
