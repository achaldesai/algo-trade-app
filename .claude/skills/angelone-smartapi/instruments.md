# Instrument Master

To subscribe to a tick feed you need the `symboltoken` for each symbol. Tokens come from the daily-published instrument master file.

## Source

```
https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json
```

- Single JSON array, ~150k entries, ~25 MB.
- Refreshed once per trading day (~8 AM IST). Tokens DO change for new contracts and expiries — fetch daily and rebuild your local lookup.
- No auth required.

## Schema

Each entry:
```json
{
  "token": "3045",
  "symbol": "SBIN-EQ",
  "name": "SBIN",
  "expiry": "",
  "strike": "-1.000000",
  "lotsize": "1",
  "instrumenttype": "",
  "exch_seg": "NSE",
  "tick_size": "5.000000"
}
```

Field meanings:
- `token` — the `symboltoken` you pass to all REST and WebSocket calls. **String, even though numeric.**
- `symbol` — full trading symbol with suffix:
  - Cash equities: `SBIN-EQ` (NSE), `500325` (BSE — BSE uses scrip code as symbol).
  - F&O: `SBIN26MAY970CE` for SBIN May-2026 970 Call. Format: `<UNDERLYING><YY><MMM><STRIKE><CE|PE|FUT>`.
  - Indices: `Nifty 50`, `Nifty Bank` (with spaces).
- `name` — base/underlying name (`SBIN`, `NIFTY`).
- `expiry` — `DDMMMYYYY` (e.g., `29MAY2026`) for derivatives; empty for equities.
- `strike` — strike × 100 as a string (e.g., `"97000.000000"` = ₹970). For non-options: `"-1.000000"`.
- `lotsize` — string integer.
- `instrumenttype` — `OPTIDX` / `OPTSTK` / `FUTIDX` / `FUTSTK` / `FUTCOM` / `OPTFUT` / etc. Empty for cash equities.
- `exch_seg` — exchange segment string. Mapping to the WebSocket `exchangeType` integer:

| `exch_seg` | exchangeType code |
|---|---|
| `NSE` | 1 (NSE_CM) |
| `NFO` | 2 (NSE_FO) |
| `BSE` | 3 (BSE_CM) |
| `BFO` | 4 (BSE_FO) |
| `MCX` | 5 (MCX_FO) |
| `NCDEX` | 7 (NCX_FO) |
| `CDS` | 13 (CDE_FO) |

- `tick_size` — minimum price increment × 100. So `"5.000000"` = 5 paise = ₹0.05.

## Build a lookup

Recommended: index by `(exchange_segment, symbol) → token` and `(exchange_segment, token) → symbol` so you can go both directions cheaply.

```ts
const map = new Map<string, InstrumentRow>();
for (const row of master) {
  map.set(`${row.exch_seg}:${row.symbol}`, row);
  map.set(`${row.exch_seg}:${row.token}`, row);
}
```

Refresh on startup AND once per day at ~8:30 AM IST (after Angel publishes the new file). Cache to disk; the file is large.

## Common gotchas

- **BSE symbols have no `-EQ` suffix.** They use the BSE scrip code as the trading symbol (e.g., RELIANCE on BSE = `"500325"`, NSE = `"RELIANCE-EQ"`).
- **Index tokens differ from underlying equity tokens.** `NIFTY 50` index has its own token under `exch_seg: "NSE"` but `name: "NIFTY"`. To subscribe to the index level, use the index token, not any constituent.
- **Tokens DO churn day to day** for option contracts as new strikes get listed and old ones expire. If you cache yesterday's master, today's subscribes for newly-listed strikes will fail with no obvious error. Always refresh daily.
- **Symbol case is mixed.** Equities are typically uppercase (`SBIN-EQ`); some indices have title case with spaces (`Nifty 50`). Match the master verbatim — don't `.toUpperCase()` blindly.

## Validating the file

Quick sanity after download:
```bash
curl -s https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json | jq 'length'
# expect ~150,000–160,000
```

Or check a known token:
```bash
curl -s https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json | jq '.[] | select(.symbol == "SBIN-EQ" and .exch_seg == "NSE")'
# expect token "3045"
```
