# Changelog

## [Unreleased]
- **Automatic Token Refresh**: Added `TokenRefreshService` for automatic daily re-authentication at 4:30 AM IST for Angel One (eliminates manual token renewal)
- **Token Persistence**: Migrated authentication tokens from file-based storage to LMDB with ACID guarantees, automatic expiry validation, and backup integration via `TokenRepository`
- **Angel One Integration**: Added manual token refresh endpoint `POST /api/auth/angelone/refresh` and updated SmartAPI TypeScript definitions with `generateToken()` method
- **Test Fixes**: Updated all tests to use Indian stock symbols (RELIANCE, TCS) instead of US symbols (AAPL) after market migration, fixing 4 previously failing test suites
- Replaced PostgreSQL storage with a file-backed repository and added the `npm run once` CLI for single-run workflows.
- Removed the Upstox broker integration and restricted `BROKER_PROVIDER` to paper or Zerodha.
- Upgraded development tooling: replaced `ts-node-dev` with `tsx` for hot reloads and migrated ESLint to v9 flat config with TypeScript 8 support.
- Added AGENTS.md contributor guide covering project structure, commands, style, testing, and security tips.
