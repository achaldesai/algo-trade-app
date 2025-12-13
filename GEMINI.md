# GEMINI.md

This file provides guidance to Gemini when working with code in this repository.

## Development Commands

- **Development**: `npm run dev` - Start development server on port 3000
- **Build**: `npm run build` - Compile TypeScript to `dist/`
- **Production**: `npm start` - Run the compiled build
- **Testing**: `npm test` - Run all `*.test.ts` files using Node 18's built-in test runner
- **Linting**: `npm run lint` - Run ESLint v9 with TypeScript plugin
- **Run-once workflows**: `npm run once -- --strategy vwap` - Execute strategy once and exit

## Architecture Overview

This is an algorithmic trading backend with a clean separation of concerns:

### Core Components

- **Server Bootstrap**: `server.ts` initializes the HTTP server and calls `app.ts` for Express configuration
- **Dependency Container**: `container.ts` implements a simple service container pattern with singleton services
- **Configuration**: Environment variables are centralized in `config/env.ts` with validation in `config/validateEnv.ts`

### Service Layer Architecture

The application uses a layered architecture with dependency injection:

1. **PortfolioService** - Manages stocks, trades, and position calculations
2. **MarketDataService** - Handles market tick data and snapshots
3. **TradingEngine** - Orchestrates strategies, market data, and broker execution
4. **BrokerClient Interface** - Abstraction for order execution (Paper/Zerodha implementations)

### Key Patterns

- **Broker Abstraction**: All broker implementations extend `BrokerClient` interface. Paper broker for development, Angel One/Zerodha for production
- **Ticker Abstraction**: `TickerClient` interface for real-time market data. `AngelOneTickerService` provides free WebSocket streaming
- **Strategy Pattern**: Trading strategies extend `BaseStrategy` and generate signals from market/portfolio context
- **Repository Pattern**: Portfolio data persistence supports both LMDB (default) and JSON file backends
- **Container Pattern**: Services are resolved through `getContainer()` with resolver functions like `resolvePortfolioService()`, `resolveTickerClient()`
- **Provider Pattern**: Historical data providers implement `HistoricalDataProvider` interface for pluggable data sources

### Data Flow

1. Market data flows through `MarketDataService`
2. `TradingEngine` combines market data + portfolio state + strategy signals
3. Generated orders route to the configured `BrokerClient`
4. Trade executions persist via `PortfolioService`

## Environment Configuration

Key environment variables:

- `BROKER_PROVIDER`: `paper` (default), `angelone`, or `zerodha`
- `DATA_PROVIDER`: Market data source (defaults to `BROKER_PROVIDER`). Set to `angelone` to use Angel One WebSocket ticker for real-time data while using a different broker
- `ANGEL_ONE_API_KEY`: Angel One SmartAPI key (required for `angelone` broker/data)
- `ANGEL_ONE_CLIENT_ID`: Angel One client ID
- `ANGEL_ONE_PASSWORD`: Angel One password
- `ANGEL_ONE_TOTP_SECRET`: TOTP secret for automatic 2FA (optional)
- `PORTFOLIO_BACKEND`: `lmdb` (default) or `file`
- `PORTFOLIO_STORE`: Custom path for data storage
- `PORT`: Server port (default 3000)
- `BACKUP_INTERVAL_HOURS`: Backup frequency in hours (default 24)
- `DRY_RUN`: Set to `true` to test strategies without executing real trades (default `false`)
- `MAX_POSITION_SIZE`: Maximum position value in currency units (default 100000)
- `ADMIN_API_KEY`: **REQUIRED for production** - Secure API key for admin endpoints (default: "")
- `DISCORD_WEBHOOK_URL`: Discord webhook URL for notifications (optional)
- `WEBHOOK_URL`: Generic webhook URL for notifications (optional)
- `NOTIFICATIONS_ENABLED`: Set to `false` to disable notifications (default `true`)

**Note**: Angel One SmartAPI provides **FREE** market data and historical data APIs. See `docs/ANGEL_ONE_SETUP.md` for setup instructions.

### Decoupled Data & Broker Architecture

The app separates market data and trading concerns:

```bash
DATA_PROVIDER=angelone     # FREE real-time market data
BROKER_PROVIDER=zerodha    # Trade via Zerodha (or paper/angelone)
```

This allows using Angel One's free WebSocket ticker while trading through any broker.

### Real-Time Market Data (WebSocket)

When `DATA_PROVIDER=angelone`, the server connects to Angel One's WebSocket for live tick data:

- **Service**: `AngelOneTickerService` manages WebSocket connection
- **Auto-reconnect**: Handles disconnections with automatic retry
- **Heartbeat**: Keeps connection alive with periodic pings
- **Event emission**: `MarketDataService` emits `tick` events for each price update

## Database Backups (LMDB)

The application includes automatic backup functionality for LMDB databases:

### Automatic Backups

- **Frequency**: Configurable via `BACKUP_INTERVAL_HOURS` (default: daily)
- **Location**: `backups/` directory in project root
- **Retention**: Last 7 backups are kept automatically
- **On Startup**: Creates initial backup when server starts

### Manual Backup Management

Admin API endpoints for backup operations (require `X-Admin-API-Key` header):

```bash
# Set your admin API key as a header
API_KEY="your_admin_api_key"

# Create manual backup
curl -X POST -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/admin/backup

# List all backups
curl -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/admin/backups

# Restore from backup
curl -X POST -H "X-Admin-API-Key: $API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"backupPath": "/path/to/backup"}' \
     http://localhost:3000/api/admin/restore

# Export database to JSON
curl -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/admin/export

# Get database statistics
curl -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/admin/db-stats

# Health check
curl -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/admin/health
```

**Security Note**: All admin endpoints require the `X-Admin-API-Key` header with a valid API key. Without `ADMIN_API_KEY` configured in your environment, these endpoints will return `503 Service Unavailable`.

### Backup Contents

Each backup is a timestamped directory containing:

- `data.mdb` - LMDB database file
- `lock.mdb` - Lock file

### Restore Procedure

1. List available backups: `GET /api/admin/backups`
2. Choose a backup path
3. Restore: `POST /api/admin/restore` with `backupPath`
4. Server automatically reinitializes the database

## Authentication & Token Management

### Automatic Token Refresh (Angel One)

The application includes automatic token refresh to eliminate manual re-authentication:

**Automatic Daily Re-authentication:**

- Runs at 4:30 AM IST daily (before 5 AM token expiry)
- Scheduler computes the next run entirely in UTC to stay stable across host timezones
- Falls back to a full re-authentication when the stored token is missing or expired
- Uses TOTP for automatic 2FA (requires `ANGEL_ONE_TOTP_SECRET`)
- Zero manual intervention required
- Managed by `TokenRefreshService`

**Manual Token Refresh:**

```bash
# Refresh current token (keeps same expiry)
curl -X POST http://localhost:3000/api/auth/angelone/refresh
```

**Token Storage:**

- All tokens stored in LMDB with ACID guarantees
- Automatic expiry validation
- Included in automatic backups
- Migrates automatically from old file-based storage

**Authentication Endpoints:**

- `POST /api/auth/angelone/login` - Initial authentication
- `GET /api/auth/angelone/status` - Check authentication status
- `POST /api/auth/angelone/refresh` - Manual token refresh
- `POST /api/auth/angelone/logout` - Clear session

## Trading Loop & Control API

The application includes a real-time trading loop that evaluates strategies on every market tick.

### Trading Loop Service

- **Event-driven**: Listens to `MarketDataService` tick events
- **Automatic evaluation**: Runs all registered strategies on each tick
- **Managed by**: `TradingLoopService` singleton initialized at server startup

### Control API Endpoints

Control the trading loop and execute emergency actions (require `X-Admin-API-Key` header):

```bash
API_KEY="your_admin_api_key"

# Check trading loop status
curl -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/control/status

# Start the trading loop
curl -X POST -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/control/start

# Stop the trading loop
curl -X POST -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/control/stop

# Emergency: Sell all positions immediately
curl -X POST -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/control/panic-sell
```

**Panic Sell**: Stops the trading loop and liquidates all open positions. Use in emergencies only.

### Web Dashboard

A static web dashboard is served from `public/` for monitoring and control:

- **URL**: `http://localhost:3000/`
- **Features**: Real-time status, start/stop controls, panic sell button, P&L display
- **Files**: `public/index.html`, `public/styles.css`, `public/dashboard.js`

### P&L API

Real-time profit and loss tracking:

```bash
# Get today's P&L summary
curl http://localhost:3000/api/pnl/daily

# Get overall P&L summary
curl http://localhost:3000/api/pnl/summary

# Get open positions with live prices
curl http://localhost:3000/api/pnl/positions
```

**Dashboard P&L Display:**

- Daily realized P&L (from closed trades)
- Unrealized P&L (from open positions with live prices)
- Positions table with entry price, current price, P&L %, and stop-loss levels
- Auto-refreshes every 2 seconds

## Performance & Optimization

### Rate Limiting
Global rate limiting is applied to all API endpoints to prevent abuse:
- **Limit**: 100 requests per 15-minute window per IP
- **Headers**: Standard `RateLimit-*` headers are included in responses

### Caching
- **P&L Caching**: `/api/pnl/daily` is cached in-memory for 5 seconds to reduce computation load during frequent polling.

## Safety Features

### Dry-Run Mode

Test strategies without executing real trades:

```bash
DRY_RUN=true npm start
```

In dry-run mode:

- Orders are logged but not executed
- No trades are recorded in the database
- Useful for testing strategies with live market data

### Position Limits

Configurable safety checks prevent oversized positions:

- `MAX_POSITION_SIZE`: Maximum value for a single position (default: 100,000)
- Orders exceeding this limit are rejected
- Validation occurs before broker execution

### Order Validation

All orders are validated before execution:

- Price must be positive
- Quantity must be greater than zero
- Position size must not exceed limits

### Circuit Breaker
- **Trigger**: Automatic trading halt if daily loss limit is exceeded
- **Persistence**: Circuit breaker state is persisted to database and survives server restarts
- **Reset**: Can be manually reset via API or automatically on daily reset

### Stop-Loss Automation

Automatic stop-loss protection for all positions:

**Automatic Stop-Loss Creation:**

- Stop-losses are automatically created when positions are opened via strategy execution
- Default stop-loss at `stopLossPercent` below entry price (configurable via dashboard settings)
- Supports both FIXED and TRAILING stop-loss types

**Stop-Loss API Endpoints:**

All stop-loss endpoints require `X-Admin-API-Key` header.

```bash
API_KEY="your_admin_api_key"

# List all active stop-losses
curl -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/stop-loss

# Get stop-loss for a specific symbol
curl -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/stop-loss/RELIANCE

# Update/create stop-loss manually
curl -X PUT -H "X-Admin-API-Key: $API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"stopLossPrice": 95.50, "type": "FIXED"}' \
     http://localhost:3000/api/stop-loss/RELIANCE

# Create trailing stop-loss
curl -X PUT -H "X-Admin-API-Key: $API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"trailingPercent": 5, "type": "TRAILING", "entryPrice": 100, "quantity": 10}' \
     http://localhost:3000/api/stop-loss/TCS

# Remove stop-loss
curl -X DELETE -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/stop-loss/RELIANCE

# Start/stop stop-loss monitor
curl -X POST -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/stop-loss/start
curl -X POST -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/stop-loss/stop
```

**How It Works:**

1. When a BUY trade executes, `StopLossMonitor` auto-creates a stop-loss at the configured percentage below entry
2. On each market tick, stop-losses are checked against current prices
3. When price breaches the stop-loss, a MARKET SELL order is immediately executed
4. Trailing stops update their stop-loss price upward as the price rises

**Integration with Trading Loop:**

- Stop-loss monitor starts/stops alongside the trading loop
- Both are stopped during panic sell operations
- Control status includes stop-loss monitoring state

## Audit Logging

The application includes comprehensive audit logging for all important events:

### Logged Event Types

- **Trade Events**: `TRADE_EXECUTED`, `TRADE_FAILED`
- **Stop-Loss Events**: `STOP_LOSS_TRIGGERED`, `STOP_LOSS_EXECUTED`, `STOP_LOSS_CREATED`, `STOP_LOSS_UPDATED`, `STOP_LOSS_REMOVED`
- **Strategy Events**: `STRATEGY_SIGNAL`, `STRATEGY_EVALUATION`
- **System Events**: `SETTINGS_CHANGED`, `CIRCUIT_BREAKER_TRIGGERED`, `TRADING_STARTED`, `TRADING_STOPPED`, `PANIC_SELL`, `RECONCILIATION`, `SYSTEM`

### Audit API Endpoints

Audit log endpoints require `X-Admin-API-Key` header.

```bash
API_KEY="your_admin_api_key"

# Query audit logs with optional filters
curl -H "X-Admin-API-Key: $API_KEY" "http://localhost:3000/api/audit-logs?limit=50&eventType=TRADE_EXECUTED"

# Get today's audit logs
curl -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/audit-logs/today

# Get audit log statistics by event type
curl -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/audit-logs/stats

# Get audit logs for a specific symbol
curl -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/audit-logs/symbol/RELIANCE

# Clean up old audit logs (admin operation)
curl -X POST -H "X-Admin-API-Key: $API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"retentionDays": 30}' \
     http://localhost:3000/api/audit-logs/cleanup
```

### Query Parameters

- `limit` - Max entries to return (default: 100, max: 500)
- `offset` - Pagination offset
- `from` - Start date (ISO format)
- `to` - End date (ISO format)
- `eventType` - Comma-separated event types
- `symbol` - Filter by symbol
- `category` - Filter by category (`trade`, `risk`, `strategy`, `system`)
- `severity` - Filter by severity (`info`, `warn`, `error`)

### Architecture

- **AuditLogService**: Subscribes to system events and automatically logs them
- **LmdbAuditLogRepository**: Persists logs to LMDB for durability
- **Storage Path**: Configurable via `AUDIT_LOG_STORE` env var

## Health Monitoring

Comprehensive health monitoring for "set and forget" trading systems.

### Health Endpoint

The `/api/admin/health` endpoint provides component-level health status:

```bash
curl -H "X-Admin-API-Key: $API_KEY" http://localhost:3000/api/admin/health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "uptime": 3600,
  "memory": { "used": 150, "total": 512, "percentUsed": 29.3 },
  "components": [
    { "name": "broker", "status": "healthy", "message": "Connected (zerodha)" },
    { "name": "ticker", "status": "healthy", "message": "Connected (last tick 2s ago)" },
    { "name": "database", "status": "healthy", "message": "LMDB operational" },
    { "name": "tradingLoop", "status": "healthy", "message": "Running (parallel mode)" },
    { "name": "stopLoss", "status": "healthy", "message": "Monitoring 3 positions" }
  ]
}
```

### Status Levels

- **healthy**: All components operational
- **degraded**: Some components have issues but system is functional
- **unhealthy**: Critical components are failing

### Dashboard Health Indicator

The dashboard shows a health status indicator in the header:
- 🟢 Green dot: All systems healthy
- 🟡 Yellow dot: Degraded (shows which components)
- 🔴 Red dot: Unhealthy

Also displays uptime and memory usage.

### Components Monitored

| Component | Checks |
|-----------|--------|
| Broker | Connection status, broker name |
| Ticker | WebSocket connection, last tick age |
| Database | LMDB read test |
| Trading Loop | Running/stopped, evaluation mode |
| Stop-Loss | Monitoring status, active count |

## Discord/Webhook Notifications

Send alerts to Discord or any webhook endpoint when important trading events occur.

### Configuration

Set environment variables to enable notifications:

```bash
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/123/abc  # Discord webhook
WEBHOOK_URL=https://example.com/webhook                       # Generic webhook
NOTIFICATIONS_ENABLED=true                                    # Default: true
```

### Events Notified

| Event | Description | Discord Color |
|-------|-------------|---------------|
| Trade Executed | BUY/SELL order filled | Green |
| Stop-Loss Triggered | Price hit stop level | Yellow |
| Stop-Loss Executed | Position closed by stop | Orange |
| Trading Started/Stopped | Loop state changes | Blue |
| Panic Sell | Emergency liquidation | Red |

### API Endpoints

```bash
# Check notification status
curl http://localhost:3000/api/notifications/status

# Send test notification
curl -X POST http://localhost:3000/api/notifications/test
```

### Dashboard Integration

The dashboard shows notification status under Settings:
- **Status indicator**: Configured/Not Configured
- **Test button**: Send a test notification to verify setup

## Remote Access (Discord Bot)

Control your dashboard remotely by tunneling it securely via **Cloudflare Quick Tunnels**.

### Configuration

Add these to your `.env`:
```bash
DISCORD_BOT_TOKEN=your_bot_token          # Required for bot
# No other configuration needed - tunnels are free and zero-config!
```

### ⚠️ Critical Setup Steps

1.  **Enable Intents**:
    - Go to [Discord Developer Portal](https://discord.com/developers/applications) > Your App > **Bot** tab.
    - Scroll down to "Privileged Gateway Intents".
    - Enable **MESSAGE CONTENT INTENT**. (Required to read "!dashboard")
    - Click **Save Changes**.

2.  **Invite Bot to Server**:
    - Go to **OAuth2** tab > **URL Generator**.
    - Select Scope: `bot`.
    - Select Bot Permissions: `Send Messages`, `Read Messages/View Channels`.
    - Copy the generated URL and open it in your browser to invite the bot.

### Commands

Direct Message (DM) your bot with:

- `!dashboard`: Opens a secure tunnel for 15 minutes. Bot replies with the URL (trycloudflare.com).
- `!stop`: Closes the tunnel immediately.

**Note**: The tunnel exposes your **unauthenticated** dashboard to anyone with the link. Do not share the URL.

## Technical Indicators (Fixed)

The `TechnicalIndicators` service provides accurate calculations:

- **EMA**: Uses SMA for first value (industry standard), then applies exponential smoothing
- **MACD**: Properly initialized signal line using SMA of MACD values
- **RSI**: 14-period default with proper gain/loss calculation
- **Bollinger Bands**: Standard 20-period with 2 standard deviations
- **SMA**: Simple moving average

**Note**: EMA calculation was fixed to use SMA for initialization instead of just the first candle price.

## HST Optimizations

High-Speed Trading optimizations for low-latency live market data processing:

### Incremental Indicators (O(1) per tick)

`IncrementalIndicators.ts` provides streaming indicator updates without full recalculation:

- `IncrementalEMA`, `IncrementalSMA`, `IncrementalRSI`, `IncrementalMACD`, `IncrementalBollingerBands`
- `IncrementalIndicatorSuite` - Combined suite for per-symbol tracking
- Automatically updated by `MarketDataService` on each tick

### Ring Buffer

`RingBuffer.ts` provides pre-allocated circular buffer:

- Fixed capacity with O(1) push/get operations
- No garbage collection overhead during trading
- Used by `MarketDataService` for tick history (1000 ticks/symbol default)

### Parallel Strategy Evaluation

`TradingLoopService` now supports configurable evaluation modes:

```typescript
loop.setEvaluationMode("parallel");  // Default - concurrent evaluation
loop.setEvaluationMode("sequential"); // For order-dependent strategies
```

Features:
- Tick skip when previous evaluation still in progress (prevents queue buildup)
- Latency logging for slow evaluations (>50ms)

### Accessing Real-Time Indicators

Strategies can access pre-computed indicators without recalculation:

```typescript
const indicators = marketData.getIndicators(symbol);
if (indicators?.rsi && indicators.rsi < 30) {
  // Oversold signal
}
```

## Testing Strategy

- Uses Node 18's built-in `node:test` runner
- Tests are co-located as `*.test.ts` files
- Mock broker calls using deterministic fixtures from `src/data/`
- Test runner is in `scripts/run-tests.ts`
- Includes tests for dry-run mode, position limits, and technical indicators
- **Service Tests**: Dedicated unit tests for `TradingLoopService`, `ReconciliationService`, and `RiskManager`
- **Utility Tests**: `RingBuffer` verified with comprehensive test suite

## Key Extension Points

- **New Brokers**: Implement `BrokerClient` interface in `src/brokers/`
- **New Tickers**: Implement `TickerClient` interface in `src/services/` (see `AngelOneTickerService`)
- **New Strategies**: Extend `BaseStrategy` in `src/strategies/`
- **New Persistence**: Implement repository pattern in `src/persistence/`
- **New Routes**: Add route modules to `src/routes/` and wire in `app.ts`

