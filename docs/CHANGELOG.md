# Changelog

## [Unreleased]

### Beta readiness
- **Security**: public `/api/users/register` no longer accepts a client-supplied role — the first user becomes ADMIN, afterwards only an ADMIN JWT can choose a role, and self-signup is closed in production (ACH-5).
- **Security**: single `getJwtSecret()` in `src/utils/jwtSecret.ts` (ACH-9); `helmet` security headers on all responses including the dashboard; 20 failed attempts / 15 min limit on login/register (ACH-10).
- **Docker**: image now ships `public/` (dashboard previously 404'd); Postgres/Redis no longer published on the host and require `POSTGRES_PASSWORD` / `REDIS_PASSWORD`; container health checks on `/health` (ACH-7, ACH-8, ACH-12).
- **CI**: runs `npm run build` and a Docker image build (ACH-13).
- **Tests**: auth middleware, registration, PaperBroker, incremental indicators (ACH-11).
- **Features**: Yahoo historical provider (`HISTORICAL_PROVIDER`, default `yahoo`), configurable scanner universe, `MAX_POSITION_SIZE_PER_SYMBOL`, `FeedHealthMonitor` stops trading on a stale feed.

### Known limitations (beta)
- Only one strategy (`VWAPStrategy`); no backtesting yet (ACH-14).
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
