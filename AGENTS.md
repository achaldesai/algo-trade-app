# Repository Guidelines

## Project Structure & Module Organization
Source code lives in `src/`. `server.ts` boots Express and hands control to `app.ts`, which composes middleware and routes. Keep domain behavior in `brokers/`, `services/`, and `strategies/`, and share utilities via `utils/`. Shape HTTP contracts under `routes/`, with reusable guards in `middleware/`. Configuration is centralized in `config/env.ts`, reading from `.env`. TypeScript builds land in `dist/`, reference docs belong in `docs/`, and deterministic fixtures can sit in `src/data/`. Co-locate tests as `*.test.ts` beside the code under test or group wider flows in `tests/`.

### Weekly Trading Services
The enhanced service layer supports sophisticated weekly trading operations:
- `HistoricalDataService` - Fetches and caches OHLCV data with configurable TTL (default 4 hours)
- `PortfolioRebalancer` - Calculates target vs actual positions and generates rebalancing orders
- `TechnicalIndicators` - Provides SMA, EMA, RSI, MACD, Bollinger Bands, volatility analysis, and trend detection
- `ExecutionPlanner` - Optimizes order timing and sizing to minimize market impact with TWAP support
- `TradingEngine` - Orchestrates weekly strategy execution combining market data, portfolio state, and broker execution

### Authentication & Token Management
- `AuthService` - Manages broker authentication state with automatic token loading on startup
- `TokenRefreshService` - Handles automatic daily token refresh at 4:30 AM IST for Angel One (prevents manual re-authentication)
- `TokenMigrationService` - One-time migration service for moving file-based tokens to LMDB storage
- Token storage uses LMDB with ACID guarantees, automatic expiry checking, and backup integration
- Supports both Zerodha and Angel One authentication with TOTP-based automatic 2FA for Angel One

### Persistence Layer
- `TokenRepository` (LMDB) - Stores authentication tokens with automatic expiry validation
- `PortfolioRepository` (LMDB or File) - Persists stocks, trades, and portfolio state
- `InstrumentMasterService` - Downloads and caches Angel One instrument master for symbol-to-token mapping
- Automatic database backups every 24 hours with 7-backup retention

### Service Dependencies
Services are wired through the container pattern in `container.ts` with resolver functions. The weekly trading workflow follows: Historical Data → Technical Analysis → Portfolio Rebalancing → Execution Planning → Order Execution. Authentication flow: Token Migration → Auth Service → Token Refresh Scheduler → Broker Initialization.

## Build, Test, and Development Commands
- `npm run dev` starts the hot-reloading dev server via `tsx watch`.
- `npm run build` compiles TypeScript to production JavaScript in `dist/`.
- `npm start` serves the compiled build to mirror production settings.
- `npm run lint` runs ESLint v9 with the TypeScript plugin suite.
- `npm test` executes the Node 18 `node:test` suite over all `*.test.ts` files.

## Coding Style & Naming Conventions
Write modern TypeScript targeting Node 18 with 2-space indentation and double quotes. Keep modules focused on a single responsibility and export domain-named artefacts such as `strategies/momentumStrategy.ts` or `middleware/requestLogger.ts`. Use camelCase for values, PascalCase for types and classes, and UPPER_SNAKE_CASE for constants. Resolve lint warnings at the source rather than disabling rules.

## Testing Guidelines
Use the built-in `node:test` runner with deterministic fixtures from `src/data/`. Cover happy and failure paths for routes and middleware, faking broker calls where needed. Keep suites isolated and quick; ensure `npm test` passes before pushing. Name specs after their target (`app.test.ts`) for easy discovery.

### Weekly Trading Service Testing
- Mock historical data with realistic OHLCV patterns for strategy backtesting
- Test portfolio rebalancing calculations with various drift scenarios and allocation targets
- Verify technical indicators against known values using deterministic price sequences
- Simulate execution planning under different market conditions (high/low volatility, various order sizes)
- Mock broker responses for order execution testing and failure scenarios

## Commit & Pull Request Guidelines
Follow the existing Git history pattern: short, imperative subjects that capture intent (e.g., "Add broker position hydrator"). Group related edits into one commit and add body context only when behavior shifts. Pull requests should link tracking issues, explain motivation, enumerate local testing, and include API samples or screenshots for user-facing changes.

## Security & Configuration Tips
Never commit secrets—load broker credentials via `.env` and `config/env.ts`. Default production logging to concise levels and enable verbose logs only when diagnosing incidents. Validate broker integrations against sandbox endpoints before targeting live URLs, and strip sensitive data from shared logs.

## Weekly Strategy Development Guidelines
- Implement strategies extending `BaseStrategy` with focus on weekly frequency and multi-period analysis
- Use `HistoricalDataService` to fetch 252+ days of data for meaningful technical analysis
- Leverage `TechnicalIndicators` for trend detection, volatility analysis, and signal generation
- Apply `PortfolioRebalancer` with appropriate drift thresholds (typically 5-10% for weekly rebalancing)
- Use `ExecutionPlanner` for large orders (>$50k) to minimize market impact with TWAP execution
- Design strategies to handle position reconciliation between broker state and internal tracking
- Consider weekly market patterns and avoid executing during high volatility periods (market open/close)

## Trading Operations Best Practices
- Cache historical data with 4-hour TTL to balance API costs with data freshness
- Set reasonable position size limits (max 10% of average daily volume per order)
- Implement cash reserve ratios (5% recommended) to handle execution slippage
- Use limit orders during high volatility periods (>30% annualized) instead of market orders
- Plan execution timing to avoid market open volatility and low liquidity periods
- Maintain audit logs of all trading decisions and execution outcomes for regulatory compliance
