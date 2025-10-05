# Algo Trade Service

A modern TypeScript backend that manages algorithmic trading data such as stocks, trades, and portfolio summaries. The service provides a lightweight REST API that can be extended with broker integrations or connected to any front-end dashboard.

## Prerequisites

- Node.js >= 18.17
- npm >= 9

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the development server with automatic reload:
   ```bash
   npm run dev
   ```
3. Build the production bundle:
   ```bash
   npm run build
   ```
4. Serve the compiled output:
   ```bash
   npm start
   ```

The server listens on port `3000` by default. Override the port or enable request logging via environment variables:

```bash
PORT=4000 REQUEST_LOGGING=true npm run dev
```

## Available Endpoints

| Method | Path              | Description                                      |
| ------ | ----------------- | ------------------------------------------------ |
| GET    | `/health`         | Health probe used for readiness checks.         |
| GET    | `/api/stocks`     | Returns the catalog of tracked instruments.     |
| POST   | `/api/stocks`     | Adds a new stock symbol to the catalog.         |
| GET    | `/api/trades`     | Lists trades ordered by most recent execution.  |
| POST   | `/api/trades`     | Records a trade (buy or sell) for an instrument.|
| GET    | `/api/trades/summary` | Aggregates trades into high level positions. |
| GET    | `/api/market-data` | Fetches the latest cached market ticks.        |
| POST   | `/api/market-data/ticks` | Inserts a single market tick.          |
| POST   | `/api/market-data/batch` | Inserts multiple ticks in one request. |
| GET    | `/api/strategies` | Lists registered trading strategies.           |
| POST   | `/api/strategies/:id/evaluate` | Feeds ticks (optional) and runs the strategy. |

### Sample Request

```bash
curl -X POST http://localhost:3000/api/trades \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "AAPL",
    "side": "BUY",
    "quantity": 10,
    "price": 170.25
  }'
```

## Broker & Strategy Engine

The service now ships with a broker abstraction and a basic VWAP-driven strategy engine:

- **Paper broker** – the default simulated execution venue used in development.
- **Zerodha connector** – REST client that falls back to the paper broker when offline; enable it by providing `BROKER_PROVIDER`, `BROKER_BASE_URL`, and `BROKER_API_KEY` environment variables.
- **Trading engine** – coordinates market data snapshots, portfolio state, and strategy signals before routing orders to the configured broker.
- **VWAP mean reversion strategy** – demonstrates how to translate market data deviations into actionable orders.

### Environment Flags

| Variable | Description | Default |
| --- | --- | --- |
| `BROKER_PROVIDER` | `paper` or `zerodha`. | `paper` |
| `BROKER_BASE_URL` | REST endpoint for the live broker. | _(empty)_ |
| `BROKER_API_KEY` | API token supplied by the broker. | _(empty)_ |

## Project Structure

```
src/
├── app.ts                 # Express application wiring
├── config/                # Environment configuration helpers
├── container.ts           # Service container and data seeding
├── data/                  # Initial sample data
├── middleware/            # Error handling and validation middleware
├── routes/                # REST API route definitions
├── services/              # Domain services and trading engine
├── strategies/            # Algorithmic trading strategies
├── brokers/               # Broker integrations (paper, Zerodha)
├── types.ts               # Shared TypeScript contracts
└── utils/                 # Logger and common utilities
```

## Extending the Service

- Replace the in-memory portfolio service with a persistent store (PostgreSQL, MongoDB, etc.).
- Connect to broker APIs to execute trades in real time.
- Add authentication/authorization middleware to secure the endpoints.
- Integrate with message queues to publish trade events for downstream consumers.

## License

MIT
