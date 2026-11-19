# Changelog

## [Unreleased]

### Beta readiness
- **Security**: public `/api/users/register` no longer accepts a client-supplied role — the first user becomes ADMIN, afterwards only an ADMIN JWT can choose a role, and self-signup is closed in production (ACH-5).
- **Security**: single `getJwtSecret()` in `src/utils/jwtSecret.ts` (ACH-9); `helmet` security headers on all responses including the dashboard; 20 failed attempts / 15 min limit on login/register (ACH-10).
- **Docker**: image now ships `public/` (dashboard previously 404'd); Postgres/Redis no longer published on the host and require `POSTGRES_PASSWORD` / `REDIS_PASSWORD`; container health checks on `/health` (ACH-7, ACH-8, ACH-12).
- **CI**: runs `npm run build` and a Docker image build (ACH-13).
- **Tests**: auth middleware, registration, PaperBroker, incremental indicators (ACH-11).
- **Backups**: snapshots now use LMDB's own consistent copy instead of copying the live files; failed backups are never listed. Restore stages the copy and never deletes live data first; async route errors no longer crash the server; stop-loss monitor start/stop is admin-only (ACH-11, ACH-17).
- **Features**: Yahoo historical provider (`HISTORICAL_PROVIDER`, default `yahoo`), configurable scanner universe, `MAX_POSITION_SIZE_PER_SYMBOL`, `FeedHealthMonitor` stops trading on a stale feed.

### Strategies and backtesting (ACH-14)
- **Strategies**: two new daily strategies, `ma-crossover` (SMA/EMA crossover, trend following) and `rsi-reversion` (RSI mean reversion), both long-only (ACH-18).
- **Backtesting**: `POST /api/backtest` replays daily history through a strategy, filling at the next day's open with slippage and costs. It reports return, CAGR, max drawdown, Sharpe, win rate, profit factor, exposure and a buy-and-hold benchmark, and runs are saved per user (ACH-19).
- **Dashboard**: a Backtest panel with a parameter form, metrics, equity curve, trades and run history (ACH-20).
- **Live**: daily strategies run once a day at 15:15 IST while trading is on, for users who enabled them (ACH-21).
- **Fix**: a user who disabled every strategy, or enabled only a daily one, no longer falls back to running all tick strategies with defaults (ACH-21).

### Position sizing (ACH-24)
- Daily strategies can size buys as a % of account equity (`sizing: "percent"`, `positionPct`), capped at the cash available. The default is still a fixed number of shares. Backtests supply the account balance; live runs don't yet, so percent-sized configs only sell until the broker can report funds (ACH-25).

### Monthly deposits in backtests (ACH-23)
- Backtests take an optional `monthlyContribution`, added on the first trading day of each month. Deposits don't count as profit: results show money put in, profit, XIRR, and a time-weighted CAGR. The buy-and-hold benchmark invests the same deposits on the same days. The dashboard has a Monthly Deposit field, deposit tiles, and a "money put in" line on the equity chart.

### Backtest warnings (ACH-26)
- A backtest that fires no signals, or whose buys were below one share, now says so instead of showing a silent 0%. Results report `signalCount` and `skippedSignals`. The dashboard shows these notes above the metrics and gives a Zerodha cost hint next to the costs field.

### Live account balance (ACH-25)
- Live daily strategies sized as "% of equity" now get the account balance, so they can buy as well as sell. Zerodha's balance comes from its margins API. Paper mode uses a starting cash amount you can set with `PUT /api/settings/paper-cash` (default ₹1,00,000), plus sells and minus buys. If the balance can't be read, those buys are skipped, never guessed.

### Bad historical bars (ACH-29)
- Backtests and the live daily runner now drop short price spikes that are data errors. One example is Yahoo's NIFTYBEES, BANKBEES and GOLDBEES at a tenth of their price on 2019-12-19/20. Backtests say which dates were removed. Real crashes are kept. A spike in the most recent bars can't be confirmed yet and is kept.

### Index comparison (ACH-27)
- Every backtest is now also compared with investing the same money, on the same days, in an index ETF (default NIFTYBEES, the Nifty 50). Results show the index's profit and XIRR and the strategy's gap in points. The dashboard has a Compare with Index field, an index tile and a vs Index column in the history. If the index can't be fetched, the run still completes, with a warning.

### FD comparison (ACH-28)
- Backtests can also compare with a fixed deposit at a rate you choose (`fdRatePct`, e.g. 7), funded with the same deposits on the same days. The dashboard shows an FD tile and a vs FD column. This is pre-tax and doesn't change the strategy's results. Idle cash in the strategy still earns 0%, like a Zerodha trading account.

### Health check (ACH-30)
- The dashboard no longer shows "Health unavailable" every evening. The price feed is switched off outside market hours, so it now reports "Idle: market closed" instead of unhealthy. When the system really is unhealthy, the header names the problem, e.g. "Unhealthy: ticker (Disconnected)". Memory is now reported as process RSS, with the heap measured against its limit; it used to read about 99% all the time.

### Dashboard charts (ACH-31)
- The Live Market Data chart no longer spills over the panel below it, and follows the light/dark theme, as does the Backtest chart now, even after toggling. Uptime and memory moved into the health indicator's tooltip, so the header status strip stays on one line.

### Gap-up buys (ACH-32)
- In backtests, a %-sized buy whose price opens higher the next day now buys as many shares as the cash covers, instead of being rejected outright, and the run says how many buys were resized. %-sized buys also keep 0.5% of cash back for costs and slippage. Your 50% RSI run (2021–2026) went from 3 rejected buys to none.

### Live Strategies panel (ACH-33)
- New dashboard panel to set up live or paper trading without the API. You can switch strategies on or off, set a daily strategy's settings and stocks, set paper starting cash, and see the daily run's status: trading on or off, next 15:15 IST run, last result, balance. "Use these settings live" on a backtest result copies its strategy, settings and stocks into the panel. The panel warns that saving any strategy setting means only the switched-on strategies run, VWAP included. Daily strategy configs can now name their own stocks; stocks with no price that day are skipped and reported.

### Panic sell actually sells (ACH-34)
- Panic sell used to read the broker's *trade* list as positions. In paper mode that list is empty after a restart, so it closed nothing while reporting success. With Zerodha it would only have seen today's trades, missing older holdings. It now closes net positions from the app's own records and, for Zerodha, caps each sale at what the account actually holds, never touching holdings the app didn't buy. Paper fills use the last known price after hours. It reports "closed X of Y" and is only a success when everything closed; stop-losses of closed positions are removed. The dashboard alert now shows what didn't close.

### Trading no longer switches itself on (ACH-35)
- The 09:00 IST auto-trading routine used to switch trading on every weekday morning, even after STOP or panic sell. Users without saved strategy settings then had VWAP trade the scanner's picks. Now:
  - auto-start is an opt-in setting, **off by default**, shown in Live Strategies with a switch for admins;
  - STOP and panic sell keep trading off until someone presses START;
  - the default VWAP only trades WATCHLIST stocks;
  - paper buys can't spend more than the paper cash.

### Known limitations (beta)
- Backtests use daily bars only, since the historical providers have no intraday data. With the default fixed share count, backtests are usually far less invested than buy-and-hold (see `exposurePct`); use percent sizing to compare fairly.
- Daily strategies trade at 15:15 IST at the latest price. Holidays are inferred from the absence of ticks, not from an exchange calendar.
- Angel One is used for market data only; live orders route through Zerodha.
- Single-tenant: one deployment per operator. Additional users must be created by an admin in production.
- Changing `POSTGRES_PASSWORD` does not update an existing `data/postgres` volume.

### Earlier
- **Automatic Token Refresh**: Added `TokenRefreshService` for automatic daily re-authentication at 4:30 AM IST for Angel One (eliminates manual token renewal)
- **Token Persistence**: Migrated authentication tokens from file-based storage to LMDB with ACID guarantees, automatic expiry validation, and backup integration via `TokenRepository`
- **Angel One Integration**: Added manual token refresh endpoint `POST /api/auth/angelone/refresh` and updated SmartAPI TypeScript definitions with `generateToken()` method
- **Test Fixes**: Updated all tests to use Indian stock symbols (RELIANCE, TCS) instead of US symbols (AAPL) after market migration, fixing 4 previously failing test suites
- Replaced PostgreSQL storage with a file-backed repository and added the `npm run once` CLI for single-run workflows.
- Removed the Upstox broker integration and restricted `BROKER_PROVIDER` to paper or Zerodha.
- Upgraded development tooling: replaced `ts-node-dev` with `tsx` for hot reloads and migrated ESLint to v9 flat config with TypeScript 8 support.
- Added AGENTS.md contributor guide covering project structure, commands, style, testing, and security tips.
