# Errors, Status Codes & Recovery

## Response envelope

All Angel One REST responses share this shape:

```json
{
  "status": true | false,
  "message": "SUCCESS" | "<error description>",
  "errorcode": "" | "<AB1004>" | "<...>",
  "data": { ... } | null
}
```

`status: false` = logical failure even if HTTP 200. Always check `status` before reading `data`.

## HTTP status codes

| Code | Meaning | Action |
|---|---|---|
| 200 | OK (still check `status` field) | proceed if `status: true` |
| 400 | InputException — malformed request | fix payload, do not retry |
| 401 | Auth header missing or malformed | re-check headers |
| 403 | TokenException OR PermissionException | refresh tokens; if still 403, account/permission issue |
| 429 | Rate limited | back off with jitter, retry |
| 500 | GeneralException / OrderException | log + retry once with backoff |
| 502 | DataException — bad upstream response | retry with backoff |
| 503 | NetworkException — broker network issue | retry with backoff |
| 504 | Gateway timeout | retry with backoff |

## Exception classes (Python SDK names)

These are the canonical error categories. The REST response surfaces them as `error_type` in the body when applicable:

| Class | Default code | When |
|---|---|---|
| `SmartAPIException` | 500 | Base class — never thrown directly |
| `GeneralException` | 500 | Unclassified server error |
| `TokenException` | 403 | JWT expired, revoked, malformed; refreshToken expired |
| `PermissionException` | 403 | Account lacks permission for endpoint (e.g., F&O on equity-only account) |
| `OrderException` | 500 | Order placement failed (insufficient margin, market closed, scrip not tradable, etc.) |
| `InputException` | 400 | Missing/invalid parameter (wrong enum, bad date format, missing required field) |
| `DataException` | 502 | Backend OMS returned malformed/unparseable data |
| `NetworkException` | 503 | Broker network/upstream connectivity issue |

## Common error codes

These appear in the `errorcode` field. Not exhaustive — Angel One has 100+ codes; these are the ones you'll hit most:

| Code | Meaning |
|---|---|
| `AB1000` | Invalid email / username |
| `AB1001` | Invalid password |
| `AB1002` | Client is blocked |
| `AB1003` | Client is not active |
| `AB1004` | User type must be USER |
| `AB1005` | Invalid source ID |
| `AB1006` | Invalid client local IP |
| `AB1007` | Invalid client public IP |
| `AB1008` | Invalid MAC address |
| `AB1009` | Invalid private key |
| `AB1010` | Invalid Accept header |
| `AB1011` | Invalid User-Agent |
| `AB1012` | Invalid TOTP |
| `AB1013` | API rate limit exceeded |
| `AB1014` | API access has been disabled |
| `AB1015` | Invalid product type |
| `AB1016` | Invalid order type |
| `AB1017` | Invalid duration |
| `AB1018` | Invalid exchange |
| `AB1019` | Invalid transaction type |
| `AB1031` | Couldn't connect to broker |
| `AB2000` | Token mandatory |
| `AB2001` | Invalid token |
| `AB2002` | TokenException — token expired |
| `AB2003` | Couldn't authenticate user |
| `AB2004` | Couldn't fetch user profile |
| `AB9000` | Internal error |

If `errorcode` starts with `AB1006/1007/1008/1009/1010/1011`, the request reached Angel but a header was rejected. Don't retry until you fix the header set.

## Recovery patterns

### Token expiry mid-session
- Detect: HTTP 403 + `error_type: TokenException` (or `errorcode: AB2002`).
- Action: call `generateTokens` with stored `refreshToken`. Persist new `jwtToken` AND new `feedToken`. Reconnect SmartStream. Retry original request once.
- If `generateTokens` itself returns 403, the `refreshToken` has expired (~30 days). Full re-login (TOTP) required — no silent path.

### Rate limit (HTTP 429 or `errorcode: AB1013`)
- Back off `2^attempt * 100ms + jitter`, cap at 30s.
- Hard cap retries at 5; surface to caller after that.

### WebSocket silent failure
- Symptom: handshake succeeded, subscribed, no ticks for >30s.
- Root cause is usually wrong subscribe payload format (see `smart-stream.md`).
- Action: log the raw frames you DO receive (text errors from server include `correlationID`). If you see no frames at all (not even pongs), reconnect.

### Order rejection
- Surfaces as `status: false` + `message` describing the reason.
- Common: `RMS:Margin Exceeds`, `Invalid quantity`, `Invalid price`, `Symbol not allowed for trading`.
- Don't retry — these are deterministic; fix the payload.

## Debugging checklist

When a request is failing:

1. **Print the full request** — URL, method, headers (redact JWT), body. Most failures are obvious from the headers.
2. **Print the full response** — status code, all body fields. `errorcode` + `message` together usually identify the issue.
3. **Compare against Python SDK** — `/tmp/sai/smartConnect.py` (cached) is the reference. If the SDK formats the call differently, match the SDK.
4. **Test with curl** — strip the codebase out of the loop. If curl works, your client lib is the problem; if curl also fails, your request is the problem.
5. **Check rate limits** — even one extra accidental call can trip `AB1013` if you're near the cap.
