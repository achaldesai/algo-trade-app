# Algo Trade Service

A modern TypeScript backend for algorithmic trading with **FREE** market data integration. Manage stocks, trades, and portfolios with a lightweight REST API. Supports Angel One SmartAPI for free historical data and order execution.

## 🆓 Free Market Data with Angel One

Unlike other brokers that charge ₹2000/month for market data APIs, **Angel One SmartAPI** provides:
- ✅ **FREE** historical OHLC data
- ✅ **FREE** real-time WebSocket tickers
- ✅ **FREE** market quotes and depth
- ✅ Only ₹20 per executed trade

**[Quick Start Guide](docs/ANGEL_ONE_QUICKSTART.md)** | **[Detailed Setup](docs/ANGEL_ONE_SETUP.md)**

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

Run-once workflows are supported through the lightweight CLI:

```bash
npm run once -- --strategy vwap
```

The server listens on port `3000` by default. Override the port or enable request logging via environment variables:

```bash
PORT=4000 npm run dev
```

## Available Endpoints

### Core APIs
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

### Authentication (Angel One)
| Method | Path              | Description                                      |
| ------ | ----------------- | ------------------------------------------------ |
| POST   | `/api/auth/angelone/login` | Authenticate with Angel One (auto TOTP). |
| GET    | `/api/auth/angelone/status` | Check authentication status.            |
| POST   | `/api/auth/angelone/refresh` | Manually refresh auth token.          |
| POST   | `/api/auth/angelone/logout` | Clear authentication session.          |

### Admin & Backup
| Method | Path              | Description                                      |
| ------ | ----------------- | ------------------------------------------------ |
| POST   | `/api/admin/backup` | Create manual LMDB backup.                     |
| GET    | `/api/admin/backups` | List all available backups.                   |
| POST   | `/api/admin/restore` | Restore from backup.                          |
| GET    | `/api/admin/export` | Export database to JSON.                       |
| GET    | `/api/admin/db-stats` | Get database statistics.                     |
| GET    | `/api/admin/health` | Admin health check.                            |

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
- **Angel One connector** – Full SmartAPI integration with **FREE market data** (historical OHLC, WebSocket tickers, quotes). Includes automatic TOTP authentication and daily token refresh at 4:30 AM IST.
- **Zerodha connector** – REST client that falls back to the paper broker when offline; enable it by providing `BROKER_PROVIDER`, `BROKER_BASE_URL`, and `BROKER_API_KEY` environment variables.
- **Trading engine** – coordinates market data snapshots, portfolio state, and strategy signals before routing orders to the configured broker.
- **VWAP mean reversion strategy** – demonstrates how to translate market data deviations into actionable orders.
- **Automatic Token Management** – `TokenRefreshService` handles daily re-authentication for Angel One (eliminates manual token renewal), recalculates the next 04:30 IST window purely in UTC, and triggers a full re-auth when no persisted token is found.

## 🛡️ Risk Management

The system includes a robust risk management layer that enforces:

- **Max Daily Loss**: Trading halts if daily loss limit is hit (circuit breaker).
- **Position Limits**: Max open positions and max position size checks.
- **Stop-Loss Automation**: Auto-creates stop-losses for every position (Fixed or Trailing).

## 🚨 Emergency Procedures

### Panic Sell
Immediately liquidates ALL open positions.
- **via Dashboard**: Click "PANIC SELL ALL" button (requires confirmation).
- **via API**: `POST /api/control/panic-sell` with body `{"confirmToken": "PANIC-CONFIRM"}`.

### Circuit Breaker
If triggered, all new entry orders are blocked. Emergency exits (Panic Sell, Stop-Loss) are **ALWAYS ALLOWED**.
- **Reset**: Automatic on daily reset or manual via API.

## 🔒 Security

- **Admin API Key**: Required header `X-Admin-API-Key` for sensitive endpoints.
- **CSP**: Content Security Policy enabled to prevent XSS.

### Decoupled Data & Broker Configuration

You can use **different providers** for market data and trading:

```bash
# Use Angel One's FREE market data with any broker
DATA_PROVIDER=angelone     # FREE real-time WebSocket ticks
BROKER_PROVIDER=zerodha    # Trade via Zerodha
```

This saves ₹500/month on Zerodha's market data API fees while still executing trades through Zerodha.

### Environment Flags

| Variable | Description | Default |
| --- | --- | --- |
| `DATA_PROVIDER` | Market data source: `angelone` (free) or `paper`. | Same as `BROKER_PROVIDER` |
| `BROKER_PROVIDER` | Trading broker: `paper`, `zerodha`, or `angelone`. | `paper` |
| `BROKER_BASE_URL` | REST endpoint for the live broker. | _(empty)_ |
| `BROKER_API_KEY` | API token supplied by the broker. | _(empty)_ |
| `PORTFOLIO_BACKEND` | `lmdb` (default) or `file` for JSON storage. | `lmdb` |

### Data Store

Persisted stocks and trades now default to an LMDB store located at `data/portfolio-store`. Override the location with `PORTFOLIO_STORE` if you prefer a custom path (directories for LMDB, files for the legacy JSON backend). To continue using the JSON store, set `PORTFOLIO_BACKEND=file` and point `PORTFOLIO_STORE` to a `.json` file:

```bash
PORTFOLIO_BACKEND=file PORTFOLIO_STORE=~/portfolio.json npm run once
```

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
├── persistence/           # Lightweight file-based portfolio repository
├── strategies/            # Algorithmic trading strategies
├── brokers/               # Broker integrations (paper, Zerodha)
├── types.ts               # Shared TypeScript contracts
└── utils/                 # Logger and common utilities
```

## Extending the Service

- Swap the JSON-backed store for a durable database if you ever outgrow single-user, run-once needs.
- Connect to broker APIs to execute trades in real time.
- Add authentication/authorization middleware to secure the endpoints.
- Integrate with message queues to publish trade events for downstream consumers.

## License

MIT
