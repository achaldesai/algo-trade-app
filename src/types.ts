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
  stage: "SIGNAL_GENERATION" | "EXECUTION";
  message: string;
  details?: unknown;
}
