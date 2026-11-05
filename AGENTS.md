# AGENTS.md

Operational guide for AI coding assistants working in this repo. Replaces the previous provider-specific files.

## What this is

`algo-trade-service` — a single-tenant, Node 20+ TypeScript backend for algorithmic equity trading on Indian markets (NSE). Express HTTP API + vanilla-JS dashboard in `public/`. There is no frontend build step.

The repo separates **market data** from **order execution**: Angel One streams free real-time ticks; orders route to Zerodha (live) or `PaperBroker` (simulated). They are orthogonal — `DATA_PROVIDER` and `BROKER_PROVIDER` are independent env vars. Angel One is **not** used as an order broker in normal operation despite the broker class existing.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | `ts-node src/server.ts` — dev server on port 3000 |
| `npm run build` | `tsc` to `dist/` |
| `npm start` | Run compiled build |
| `npm test` | `scripts/run-tests.ts` runs all `**/*.test.ts` via Node's built-in test runner |
| `npm run lint` / `lint:fix` | ESLint v9 |
| `npm run once -- --strategy vwap` | One-shot strategy run via `scripts/run-once.ts` |

Tests are co-located (`foo.ts` + `foo.test.ts`).

## Startup lifecycle

`src/server.ts` is a thin entry; all orchestration lives in `src/lifecycle.ts`. Startup runs nine phases in order, each with a 30s timeout. If a phase throws, the process exits — there is no degraded-mode fallback for required services.

1. **environment** — `validateEnv.ts` runs; missing required vars throw.
2. **database** — `DatabaseManager.open()` opens LMDB at `PORTFOLIO_STORE` (default `data/portfolio-store`).
3. **container** — `createContainer()` wires the DI graph and attaches it to `app.locals.container`.
4. **optionalStores** — Postgres (`DATABASE_URL`) and Redis (`REDIS_URL`) connect if configured. **Failure here is non-fatal** — code falls back to LMDB / in-memory.
5. **auth** — `TokenMigrationService` migrates any legacy file-based broker tokens into LMDB once.
6. **broker** — Connects the configured broker. **Throws if a live broker (`zerodha` / `angelone`) is not authenticated**; `paper` always succeeds. This is intentional — the system refuses to run partly-live to avoid memory leaks from endless reconnect loops.
7. **marketData** — Loads Angel One instrument master (~155k symbols), starts ticker if in market hours, subscribes to `WATCHLIST`.
8. **services** — Token refresh scheduler, reconciliation, auto-trading, backups, Discord bot.
9. **httpServer** — `app.listen()`.

When debugging startup, the logs label every phase (`Starting phase…` / `Phase started`). Match that to the phase list above.

## Architecture

### Dependency injection

There are **no module-level singletons**. Every service is constructed in `src/container.ts`, attached to `app.locals.container`, and resolved per-request via `getContainer(req)` from `src/util/getContainer.ts`. When adding a new service:

- Construct it in `createContainer()` after its dependencies.
- Add the field to the `AppContainer` type.
- Resolve via `getContainer(req).yourService` inside route handlers / middleware.

Optional services (Postgres / Redis-dependent) are typed as `T | undefined` on the container — handlers must null-check.

### Persistence

LMDB is the **primary** store. Despite a recent commit titled "remove LMDB persistence", the `lmdb` package is still in `package.json` and `DatabaseManager.ts` still uses it. The commit removed something narrower (likely a specific cache layer) — do not assume LMDB is gone.

- **LMDB** (`src/db/DatabaseManager.ts`): portfolios, trades, settings, stop-losses, audit logs, broker tokens, users, strategy configs. Stored at `PORTFOLIO_STORE`.
- **Postgres** (`src/db/postgres/`): optional. When `DATABASE_URL` is set, `PgUserRepo` / `PgTradeRepo` / `PgAuditLogRepo` are constructed alongside their LMDB counterparts. Treat as additive, not replacement — code paths still write to LMDB.
- **Redis** (`src/db/redis/`): optional. `RedisCacheService` and `RedisSessionStore`. In-memory fallback if `REDIS_URL` is absent.
- **Backups**: LMDB is snapshotted on startup and every `BACKUP_INTERVAL_HOURS` (default 24) into `data/backups/`. Last 7 retained. Restore via `POST /api/admin/restore`.

### Auth model

Two middlewares with **the same secret** (`ADMIN_API_KEY`, falling back to `"fallback-secret-for-dev"` in non-production):

- **`userAuth.ts`** — verifies JWT in `Authorization: Bearer …`. Required for most `/api/*` routes.
- **`adminAuth.ts`** — tries the same JWT but additionally requires `role === "ADMIN"`; falls back to a timing-safe `X-Admin-API-Key` header check. Used on `/api/admin`, `/api/control`, `/api/audit-logs`, parts of `/api/scanner`, `/api/stop-loss`.

Important: **if `ADMIN_API_KEY` is unset in production, all admin endpoints return 503**. In dev they work via the fallback secret, but a JWT signed with the fallback won't verify if you later set a real key — re-login after changing it.

### Broker / ticker abstractions

- `BrokerClient` interface (`src/brokers/`): `PaperBroker`, `ZerodhaBroker`, `AngelOneBroker`. Selection is via `BROKER_PROVIDER`. `PAPER_TRADING=true` overrides to `PaperBroker` regardless.
- `TickerClient` interface: `AngelOneTickerService` is the sole implementation (SmartStream V2 binary WebSocket). Started only when `DATA_PROVIDER=angelone` and Angel One tokens are valid.
- `HistoricalDataProvider` interface (`src/providers/`): `AngelOneHistoricalProvider` and `YahooHistoricalProvider`. Selection via `HISTORICAL_PROVIDER` (default `yahoo` — works with no auth).

When extending: implement the interface, register the implementation in `container.ts`. Do not add a new env-driven selector unless there's a reason it can't be a runtime choice.

### Trading loop & risk

- `TradingLoopService` evaluates registered strategies on each tick. Modes: `parallel` (default, concurrent eval, ticks dropped if previous eval still running) or `sequential`. Latency >50ms is logged.
- `StopLossMonitor` runs alongside the loop. Per-symbol promise queues serialize tick processing for a given symbol to avoid races on stop-loss state. Both FIXED and TRAILING types.
- `RiskManager` enforces `MAX_DAILY_LOSS`, `MAX_POSITION_SIZE`, `MAX_OPEN_POSITIONS`. Circuit breaker state is persisted, survives restart, resets daily. **Stop-loss execution and panic-sell bypass the circuit breaker** — that's deliberate.
- `POST /api/control/panic-sell` requires `confirmToken: "PANIC-CONFIRM"` in the body. Stops the loop, liquidates all open positions, bypasses circuit breaker, returns 503 if broker unavailable.

### Strategies

`BaseStrategy` (`src/strategies/`) is the abstract base. Currently only `VWAPStrategy` is implemented. Strategies access pre-computed indicators via `marketData.getIndicators(symbol)` — `IncrementalIndicators` keeps EMA/SMA/RSI/MACD/Bollinger updated in O(1) per tick on a `RingBuffer`. Don't recompute from scratch.

## Routes

All under `/api/*`, mounted in `src/app.ts`.

| Path | Auth | Notes |
|---|---|---|
| `/api/users` | mixed | `login` public; `register` public only for bootstrap (first user = ADMIN) and dev self-signup; rest require user JWT |
| `/api/auth` | user | Zerodha + Angel One OAuth, token mgmt |
| `/api/stocks`, `/trades`, `/strategies`, `/market-data`, `/pnl`, `/settings`, `/notifications`, `/reconciliation`, `/stop-loss` | user | Standard app routes |
| `/api/scanner` | mixed | Listed scans require admin |
| `/api/admin` | admin | DB stats, backup/restore, health |
| `/api/control` | admin | Trading loop start/stop, panic-sell |
| `/api/audit-logs` | admin | Audit query/export, sensitive fields auto-redacted |
| `/api/paper` | conditional | Mounted only when `PAPER_TRADING=true` |

Rate limits: 10000 req / 15 min globally on `/api` (dashboard polling), **60 req / 1 min** on `/api/admin`, **20 failed attempts / 15 min** per IP on `/api/users/login` and `/register`.

Security headers come from `helmet` (CSP defined in `src/app.ts`), applied before `express.static` so the dashboard gets them. No CORS headers are sent on purpose — the dashboard is same-origin.

## Frontend

Static files in `public/` served via `express.static`. No bundler.

- `index.html` + `dashboard.js` — main monitoring UI. Polls `/api/admin/health`, `/api/auth/{angelone,zerodha}/status`, `/api/reconciliation/status`, P&L endpoints.
- `orders.html` + `orders.js` — paper-mode order debug console (gated behind `PAPER_TRADING=true`).
- Auth: login form posts to `/api/users/login`, JWT stashed in `sessionStorage` (not `localStorage` — XSS hardening).

The dashboard's status tiles map directly to backend endpoints. When something says "DISCONNECTED" or "Forbidden", look at the corresponding endpoint, not just the JS.

## Environment variables

Grouped roughly by purpose. See `src/config/env.ts` for defaults and `validateEnv.ts` for required-vs-optional logic.

**Core**: `NODE_ENV`, `PORT` (3000), `WATCHLIST` (comma-separated symbols), `DRY_RUN`.

**Broker selection**: `BROKER_PROVIDER` (`paper` / `angelone` / `zerodha`), `DATA_PROVIDER` (defaults to broker), `HISTORICAL_PROVIDER` (`yahoo` / `angelone`), `PAPER_TRADING`.

**Zerodha**: `BROKER_API_KEY`, `BROKER_API_SECRET`, `BROKER_ACCESS_TOKEN`, `BROKER_REQUEST_TOKEN`, `BROKER_DEFAULT_EXCHANGE`, `BROKER_PRODUCT`, plus `ZERODHA_USER_ID` / `ZERODHA_PASSWORD` / `ZERODHA_TOTP_SECRET` for fully-automated login (no OAuth callback needed).

**Angel One**: `ANGEL_ONE_API_KEY`, `ANGEL_ONE_CLIENT_ID`, `ANGEL_ONE_PASSWORD`, `ANGEL_ONE_TOTP_SECRET`, `ANGEL_ONE_DEFAULT_EXCHANGE`, `ANGEL_ONE_PRODUCT_TYPE`. TOTP secret enables auto-refresh at 4:30 AM IST daily (token expires at 5 AM).

**Storage**: `PORTFOLIO_BACKEND` (`lmdb` / `file`), `PORTFOLIO_STORE`, `DATABASE_URL`, `POSTGRES_POOL_MIN`/`MAX`, `REDIS_URL`, `BACKUP_INTERVAL_HOURS`. Under Docker Compose, `POSTGRES_PASSWORD` and `REDIS_PASSWORD` are required and the URLs are derived from them; Postgres/Redis ports are not published on the host.

**Auth & risk**: `ADMIN_API_KEY` (required in prod; signs user JWTs and gates admin endpoints), `MAX_DAILY_LOSS`, `MAX_DAILY_LOSS_PERCENT`, `MAX_POSITION_SIZE`, `MAX_POSITION_SIZE_PER_SYMBOL`, `MAX_OPEN_POSITIONS`, `STOP_LOSS_PERCENT`, `DEFAULT_TRAILING_STOP_PERCENT`.

**Notifications**: `DISCORD_WEBHOOK_URL`, `WEBHOOK_URL`, `NOTIFICATIONS_ENABLED`, `DISCORD_BOT_TOKEN` (Discord bot for `!dashboard` tunnel via Cloudflare Quick Tunnels).

**Audit**: `AUDIT_MAX_QUEUE_SIZE`, `AUDIT_RETRY_DELAY_MS`.

## Conventions and gotchas

- **No new env-driven feature flags without a strong reason** — runtime config (settings repo) is preferred for things users would tune.
- **No silent fallbacks for required services**. Optional services (Postgres, Redis, notifications, Discord) fall back gracefully; broker auth, env validation, and ticker init do not.
- **Audit log redaction is automatic** for keys named like `password`, `token`, `secret`, `apiKey`. Don't bypass it; if you need to log something sensitive, hash it first.
- **Don't reintroduce module-level singletons.** The DI migration was deliberate. New services go in `container.ts`.
- **Don't `app.locals.foo = …` outside of `lifecycle.ts`** — the only thing on `app.locals` should be the container.
- **`getJwtSecret()` in `src/utils/jwtSecret.ts` is the only place the JWT secret is resolved.** Login signs with it; `userAuth` and `adminAuth` verify with it. Don't add another copy. Tokens minted under the dev fallback won't verify once you set a real `ADMIN_API_KEY`.
- **Registration never trusts a client-supplied role.** First user becomes ADMIN; after that only an ADMIN JWT can choose a role, and self-signup is closed in production.
- **Wrap async route handlers in `asyncHandler()`** (`src/util/asyncHandler.ts`) or catch and call `next(err)` yourself. This is Express 4: a `throw` inside a bare async handler is an unhandled rejection and crashes the process.
- **`POST /api/admin/restore` only accepts paths returned by `GET /api/admin/backups`.** `restoreFromBackup()` stages the copy and moves the live store aside, so a failed restore never deletes data. Keep it that way.
- **`POST /api/stop-loss/start|stop` are admin-only** — they control the monitor for every user.
- **Stop-loss tick processing must stay race-free.** The per-symbol promise queue in `StopLossMonitor` exists because of a real prior bug. Don't replace it with naive parallel processing.
- **Trailing stop-loss handles the "config disappears mid-update" case explicitly.** If you refactor that code, preserve the guard.
- **Strategy code should read indicators from `marketData.getIndicators(symbol)`, not recompute.** That cache exists for latency.
- **Tests use Node's built-in test runner**, not Jest/Mocha. `import { test } from "node:test"`. Mocks are deterministic fixtures from `src/data/`.

## Files an agent will most often touch

- `src/lifecycle.ts` — startup/shutdown phases.
- `src/container.ts` — DI wiring; the source of truth for what services exist.
- `src/config/env.ts` + `validateEnv.ts` — env parsing and validation.
- `src/middleware/{userAuth,adminAuth}.ts` — auth.
- `src/services/AngelOneTickerService.ts` — WebSocket ticker; sensitive to upstream protocol details (read `angelone-smartapi` skill / SmartAPI docs before changing).
- `src/services/TokenRefreshService.ts` — daily token refresh scheduler.
- `src/brokers/{Paper,Zerodha,AngelOne}Broker.ts` — order execution.
- `public/dashboard.js` — frontend; vanilla JS, polls REST endpoints. No framework.
