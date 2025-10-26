# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Development**: `npm run dev` - Start development server with hot reload on port 3000
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
- **Strategy Pattern**: Trading strategies extend `BaseStrategy` and generate signals from market/portfolio context
- **Repository Pattern**: Portfolio data persistence supports both LMDB (default) and JSON file backends
- **Container Pattern**: Services are resolved through `getContainer()` with resolver functions like `resolvePortfolioService()`
- **Provider Pattern**: Historical data providers implement `HistoricalDataProvider` interface for pluggable data sources

### Data Flow

1. Market data flows through `MarketDataService`
2. `TradingEngine` combines market data + portfolio state + strategy signals
3. Generated orders route to the configured `BrokerClient`
4. Trade executions persist via `PortfolioService`

## Environment Configuration

Key environment variables:
- `BROKER_PROVIDER`: `paper` (default), `angelone`, or `zerodha`
- `ANGEL_ONE_API_KEY`: Angel One SmartAPI key (required for `angelone` broker)
- `ANGEL_ONE_CLIENT_ID`: Angel One client ID
- `ANGEL_ONE_PASSWORD`: Angel One password
- `ANGEL_ONE_TOTP_SECRET`: TOTP secret for automatic 2FA (optional)
- `PORTFOLIO_BACKEND`: `lmdb` (default) or `file`
- `PORTFOLIO_STORE`: Custom path for data storage
- `PORT`: Server port (default 3000)
- `BACKUP_INTERVAL_HOURS`: Backup frequency in hours (default 24)
- `DRY_RUN`: Set to `true` to test strategies without executing real trades (default `false`)
- `MAX_POSITION_SIZE`: Maximum position value in currency units (default 100000)
- `ENABLE_NOTIFICATIONS`: Enable desktop notifications for trades (default `false`)

**Note**: Angel One SmartAPI provides **FREE** market data and historical data APIs. See `docs/ANGEL_ONE_SETUP.md` for setup instructions.

## Database Backups (LMDB)

The application includes automatic backup functionality for LMDB databases:

### Automatic Backups
- **Frequency**: Configurable via `BACKUP_INTERVAL_HOURS` (default: daily)
- **Location**: `backups/` directory in project root
- **Retention**: Last 7 backups are kept automatically
- **On Startup**: Creates initial backup when server starts

### Manual Backup Management

Admin API endpoints for backup operations:

```bash
# Create manual backup
POST /api/admin/backup

# List all backups
GET /api/admin/backups

# Restore from backup
POST /api/admin/restore
Body: { "backupPath": "/path/to/backup" }

# Export database to JSON
GET /api/admin/export

# Get database statistics
GET /api/admin/db-stats

# Health check
GET /api/admin/health
```

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

## Technical Indicators (Fixed)

The `TechnicalIndicators` service provides accurate calculations:
- **EMA**: Uses SMA for first value (industry standard), then applies exponential smoothing
- **MACD**: Properly initialized signal line using SMA of MACD values
- **RSI**: 14-period default with proper gain/loss calculation
- **Bollinger Bands**: Standard 20-period with 2 standard deviations
- **SMA**: Simple moving average

**Note**: EMA calculation was fixed to use SMA for initialization instead of just the first candle price.

## Testing Strategy

- Uses Node 18's built-in `node:test` runner
- Tests are co-located as `*.test.ts` files
- Mock broker calls using deterministic fixtures from `src/data/`
- Test runner is in `scripts/run-tests.ts`
- Includes tests for dry-run mode, position limits, and technical indicators

## Key Extension Points

- **New Brokers**: Implement `BrokerClient` interface in `src/brokers/`
- **New Strategies**: Extend `BaseStrategy` in `src/strategies/`
- **New Persistence**: Implement repository pattern in `src/persistence/`
- **New Routes**: Add route modules to `src/routes/` and wire in `app.ts`
- claude.md
