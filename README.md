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

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Run production server
npm start

# Run tests
npm test

# Run linting
npm run lint

# Run-once workflows
npm run once -- --strategy vwap
```

The server listens on port `3000` by default. Access the web dashboard at `http://localhost:3000/`.

## ✨ Key Features

### 🛡️ Risk Management
- **Circuit Breaker**: Auto-halt trading when daily loss limit is exceeded
- **Position Limits**: Max position size checks before order execution
- **Stop-Loss Automation**: Auto-creates stop-losses (Fixed or Trailing) for every position

### 🚨 Emergency Procedures
- **Panic Sell**: Immediately liquidates ALL positions via dashboard or API
- **Circuit Breaker Bypass**: Emergency exits (Panic Sell, Stop-Loss) always execute

### 🔒 Security
- **Admin API Key**: Required header `X-Admin-API-Key` for sensitive endpoints
- **Rate Limiting**: Global (100/15min) and Admin (10/min) rate limits
- **Constant-Time Auth**: Timing-safe comparison prevents side-channel attacks
- **CSP Headers**: Content Security Policy enabled to prevent XSS
- **Audit Logging**: All sensitive operations logged with automatic redaction

### 📊 Monitoring & Alerts
- **Web Dashboard**: Real-time P&L, positions, start/stop controls
- **Health Monitoring**: Component-level status (broker, ticker, database, trading loop)
- **Discord/Webhook Notifications**: Trade executions, stop-losses, panic sells
- **Audit Logs**: Query API for trade, risk, strategy, and system events

### ⚡ Performance
- **HST Optimizations**: O(1) incremental indicators, ring buffers, parallel evaluation
- **P&L Caching**: 5-second cache for frequently polled endpoints

## API Endpoints

### Core APIs
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health probe for readiness checks |
| GET | `/api/stocks` | Returns tracked instruments |
| POST | `/api/stocks` | Adds a new stock symbol |
| GET | `/api/trades` | Lists trades (most recent first) |
| POST | `/api/trades` | Records a trade (buy or sell) |
| GET | `/api/trades/summary` | Aggregates trades into positions |
| GET | `/api/market-data` | Fetches latest cached market ticks |
| GET | `/api/strategies` | Lists registered trading strategies |

### P&L APIs
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/pnl/daily` | Today's P&L summary |
| GET | `/api/pnl/summary` | Overall P&L summary |
| GET | `/api/pnl/positions` | Open positions with live prices |

### Authentication (Angel One)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/angelone/login` | Authenticate with Angel One |
| GET | `/api/auth/angelone/status` | Check auth status |
| POST | `/api/auth/angelone/refresh` | Manual token refresh |
| POST | `/api/auth/angelone/logout` | Clear session |

### Control APIs (require `X-Admin-API-Key`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/control/status` | Trading loop status |
| POST | `/api/control/start` | Start trading loop |
| POST | `/api/control/stop` | Stop trading loop |
| POST | `/api/control/panic-sell` | Emergency liquidate all positions |

### Stop-Loss APIs (require `X-Admin-API-Key`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stop-loss` | List all active stop-losses |
| GET | `/api/stop-loss/:symbol` | Get stop-loss for symbol |
| PUT | `/api/stop-loss/:symbol` | Create/update stop-loss |
| DELETE | `/api/stop-loss/:symbol` | Remove stop-loss |
| POST | `/api/stop-loss/start` | Start monitor |
| POST | `/api/stop-loss/stop` | Stop monitor |

### Admin APIs (require `X-Admin-API-Key`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/backup` | Create manual LMDB backup |
| GET | `/api/admin/backups` | List all backups |
| POST | `/api/admin/restore` | Restore from backup |
| GET | `/api/admin/export` | Export database to JSON |
| GET | `/api/admin/db-stats` | Database statistics |
| GET | `/api/admin/health` | Component-level health status |

### Audit Log APIs (require `X-Admin-API-Key`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/audit-logs` | Query logs with filters |
| GET | `/api/audit-logs/today` | Today's audit logs |
| GET | `/api/audit-logs/stats` | Statistics by event type |
| GET | `/api/audit-logs/symbol/:symbol` | Logs for specific symbol |
| POST | `/api/audit-logs/cleanup` | Clean up old logs |

### Notifications APIs
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/notifications/status` | Check notification config |
| POST | `/api/notifications/test` | Send test notification |

## Environment Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `BROKER_PROVIDER` | `paper`, `angelone`, or `zerodha` | `paper` |
| `DATA_PROVIDER` | Market data source | Same as `BROKER_PROVIDER` |
| `PORTFOLIO_BACKEND` | `lmdb` or `file` | `lmdb` |
| `PORTFOLIO_STORE` | Custom data path | `data/portfolio-store` |
| `DRY_RUN` | Test without executing trades | `false` |
| `MAX_POSITION_SIZE` | Max position value | `100000` |
| `ADMIN_API_KEY` | **Required for production** | `""` |
| `BACKUP_INTERVAL_HOURS` | Backup frequency | `24` |
| `DEFAULT_TRAILING_STOP_PERCENT` | Default trailing SL % | `3` |
| `DISCORD_WEBHOOK_URL` | Discord notifications | _(empty)_ |
| `WEBHOOK_URL` | Generic webhook | _(empty)_ |
| `NOTIFICATIONS_ENABLED` | Enable notifications | `true` |

### Angel One Configuration
| Variable | Description |
|----------|-------------|
| `ANGEL_ONE_API_KEY` | SmartAPI key |
| `ANGEL_ONE_CLIENT_ID` | Client ID |
| `ANGEL_ONE_PASSWORD` | Password |
| `ANGEL_ONE_TOTP_SECRET` | TOTP secret for automatic 2FA |

### Decoupled Data & Broker

Use Angel One's **FREE** market data with any broker:

```bash
DATA_PROVIDER=angelone     # FREE real-time WebSocket ticks
BROKER_PROVIDER=zerodha    # Trade via Zerodha
```

This saves ₹500/month on Zerodha's market data API fees.

## Project Structure

```
src/
├── app.ts                 # Express application wiring
├── config/                # Environment configuration
├── container.ts           # Service container & dependency injection
├── data/                  # Sample/fixture data
├── middleware/            # Error handling, validation, auth
├── routes/                # REST API route definitions
├── services/              # Domain services (trading engine, P&L, etc.)
├── persistence/           # LMDB/file repositories
├── strategies/            # Algorithmic trading strategies
├── brokers/               # Broker integrations (paper, Zerodha, Angel One)
├── types.ts               # Shared TypeScript contracts
└── utils/                 # Logger, ring buffer, indicators

public/
├── index.html             # Web dashboard
├── styles.css             # Dashboard styling
└── dashboard.js           # Dashboard logic
```

## Extending the Service

- **New Brokers**: Implement `BrokerClient` interface in `src/brokers/`
- **New Strategies**: Extend `BaseStrategy` in `src/strategies/`
- **New Tickers**: Implement `TickerClient` interface in `src/services/`
- **New Persistence**: Implement repository pattern in `src/persistence/`
