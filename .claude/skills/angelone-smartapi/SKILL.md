---
name: angelone-smartapi
description: Reference for Angel One's SmartAPI in this codebase. In algo-trade-app, Angel One is used ONLY as the live tick feed (SmartStream V2 binary WebSocket) — orders go through Zerodha or PaperBroker, NOT Angel One. Required reading before modifying anything in src/services/AngelOneTickerService.ts, src/services/TokenRefreshService.ts (for the Angel One half), or any code that touches the feedToken/jwtToken pair Angel One issues. Sources: official Python SDK at github.com/angel-one/smartapi-python and the doc portal at smartapi.angelone.in/docs.
---

# Angel One SmartAPI — Ticker Integration

## Scope in this codebase

Angel One in algo-trade-app does **one** thing: **deliver live market ticks** via the SmartStream V2 binary WebSocket. Orders are routed through **Zerodha** or **PaperBroker**, never Angel One. Portfolio, positions, holdings, GTT, etc. on Angel One are out of scope here.

What we touch:
- Authenticate with Angel One (TOTP login → jwtToken + refreshToken + **feedToken**) so we can open the WS.
- Refresh the token pair before expiry (~24h on jwt, ~30d on refresh, feedToken rotates with jwt).
- Open the SmartStream V2 WebSocket and subscribe to the universe of symbols the scanner picked.
- Decode the binary tick frames into `MarketTick` and feed `MarketDataService.updateTick()`.
- Resubscribe on reconnect.

What we don't touch (but the skill documents anyway, for grep): orders, positions, holdings, RMS, GTT, brokerage estimator, option Greeks, gainers/losers, e-DIS. These live in `rest.md` as reference; **don't wire them into product code without first checking with the user** — it would be a scope expansion, not a bug fix.

## File index

Read in this order when picking up a ticker bug:

1. **[smart-stream.md](./smart-stream.md)** — **PRIMARY**. The binary tick WebSocket. Subscribe message JSON shape, the byte-by-byte tick payload layout for LTP / Quote / SnapQuote / Depth modes, price scaling (paise → rupees ÷100), heartbeat protocol, error frames, a reference TypeScript decoder.
2. **[auth.md](./auth.md)** — login (`generateSession` with TOTP), token rotation (`generateTokens` returns new jwt AND new feedToken), required REST headers. Read before modifying token storage / refresh logic.
3. **[instruments.md](./instruments.md)** — instrument master URL, schema, the `exch_seg` → `exchangeType` integer mapping (1=NSE_CM, 2=NSE_FO, ...) you need to subscribe correctly.
4. **[errors.md](./errors.md)** — exception classes, HTTP status codes, common `errorcode` values (`AB1xxx`, `AB2xxx`), recovery patterns for 403 token expiry and rate-limited 429s.
5. **[rest.md](./rest.md)** — reference only. All Angel One REST endpoints with payloads. Useful for grep; not used at runtime in this repo.

## Endpoints we actually hit

| Surface | URL |
|---|---|
| Login (REST) | `POST https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword` |
| Refresh tokens (REST) | `POST https://apiconnect.angelone.in/rest/auth/angelbroking/jwt/v1/generateTokens` |
| Tick feed (WebSocket) | `wss://smartapisocket.angelone.in/smart-stream` |
| Instrument master (HTTP) | `https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json` |

## The current bug (as of 2026-05-01)

`src/services/AngelOneTickerService.ts` is fundamentally broken in three ways — see `smart-stream.md` for fixes. Summary:

1. **Subscribe payload uses string fields where Angel One requires integers** — `action: "subscribe"` should be `action: 1`, `mode: "FULL"` should be `mode: 3` (or 1/2/4), `exchangeType: ["NSE", ...]` should be `tokenList: [{ exchangeType: 1, tokens: [...] }, ...]`. Server silently ignores malformed subscribe; connection stays open, no data flows.
2. **Tick frames are decoded as JSON** — `JSON.parse(buffer.toString())` on binary data. Even if subscribe worked, every tick would throw. Need byte-offset decoding (subscription_mode at byte 0, exchange at byte 1, token bytes 2-26 null-terminated ASCII, sequence/timestamp/LTP as int64-LE at the documented offsets).
3. **`_connected = true` set without server confirmation** — code thinks it's healthy when it isn't, so reconnect never triggers. Use the first received frame (any text or binary) as the real liveness signal.

## Common pitfalls (from the SDK and from this repo)

1. **`Authorization: Bearer <jwt>` on the WebSocket** — REST uses `Bearer <jwt>`, but SmartStream V2 takes the **raw JWT with no `Bearer ` prefix** in the `Authorization` header (per Python SDK `connect()`). If WS handshake 4xx's, try with Bearer; some deployments accept either, but the SDK assumes raw.
2. **`X-PrivateKey` IS the API key.** Don't go looking for a separate "private key" credential — Python SDK sets `self.privateKey = api_key` directly.
3. **All four IP/MAC headers are required even though they look optional.** Missing or implausible values → silent downgrade or rejection. Use real values; SDK's hardcoded fallbacks are `127.0.0.1` (local), `106.193.147.98` (public).
4. **TOTP is the rolling 6-digit code, not the QR seed.** `generateSession(clientCode, password, totp)` expects the *current* TOTP — pass the seed and you get `errorcode: AB1012 (Invalid TOTP)`.
5. **Refreshing the JWT also rotates the feedToken.** If you only persist the new `jwtToken` after `generateTokens`, the next WS reconnect fails because the cached `feedToken` is stale. Always update both atomically.
6. **`tokens` in subscribe are STRINGS.** `"3045"`, not `3045`. Numeric tokens get rejected.
7. **Depth mode (4) is NSE_CM only and capped at 50 tokens** per connection. The SDK throws `ValueError` if you send any other exchangeType in mode 4.
8. **The Python SDK swaps best-5 buy/sell buckets in its output.** Either the on-wire `flag` is `0=sell, 1=buy` (opposite of intuition) or the SDK is buggy. Verify against `POST /market/v1/quote` for the same symbol before trusting which side is which.
9. **Instrument master tokens churn daily.** Refresh once per day at ~8:30 AM IST. Stale tokens for newly-listed option strikes silently fail to subscribe.
10. **Headers go on the WebSocket HANDSHAKE, not as a JSON message after open.** There is no post-open `authenticate` message — auth is done entirely during the upgrade. Sending `{"action": "authenticate", ...}` after open is harmless but useless; the server ignores it.

## Versioning

This skill was captured against the Python SDK's `master` branch as of **2026-05-01**. If a route 404s or a payload field mismatches, refresh against the SDK source (`github.com/angel-one/smartapi-python/tree/master/SmartApi`) and update the relevant file here — don't patch around it in product code.
