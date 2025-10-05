import type { CreateStockInput, CreateTradeInput } from "../services/PortfolioService";

export const seedStocks: CreateStockInput[] = [
  { symbol: "AAPL", name: "Apple Inc." },
  { symbol: "MSFT", name: "Microsoft Corporation" },
  { symbol: "TSLA", name: "Tesla, Inc." },
];

export const seedTrades: CreateTradeInput[] = [
  { symbol: "AAPL", side: "BUY", quantity: 10, price: 165.32, executedAt: new Date("2024-01-02T14:30:00.000Z") },
  { symbol: "AAPL", side: "BUY", quantity: 5, price: 172.11, executedAt: new Date("2024-02-01T14:30:00.000Z") },
  { symbol: "AAPL", side: "SELL", quantity: 8, price: 181.45, executedAt: new Date("2024-03-04T14:30:00.000Z") },
  { symbol: "MSFT", side: "BUY", quantity: 12, price: 312.54, executedAt: new Date("2024-01-15T14:30:00.000Z") },
  { symbol: "MSFT", side: "SELL", quantity: 5, price: 327.0, executedAt: new Date("2024-02-20T14:30:00.000Z") },
  { symbol: "TSLA", side: "BUY", quantity: 4, price: 248.19, executedAt: new Date("2024-01-10T14:30:00.000Z") },
];
