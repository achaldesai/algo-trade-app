# Authentication & Session

## Tokens you'll see

| Token | Lifetime | Used for |
|---|---|---|
| `jwtToken` | ~24h (rotates daily ~6 AM IST) | `Authorization: Bearer <jwt>` on REST. Raw value (no Bearer) on SmartStream WS. |
| `refreshToken` | ~30 days | Minting new `jwtToken` and new `feedToken` via `generateTokens`. |
| `feedToken` | Same lifetime as the jwt that minted it | `x-feed-token` header on SmartStream WS handshake. |

The `jwtToken` and `feedToken` are **both** rotated on `generateTokens` — never carry the old `feedToken` forward after a refresh; the WebSocket will fail on next reconnect.

## Login (TOTP password flow)

```
POST https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword
Headers: <auth header set, no Authorization yet>
Body:
{
  "clientcode": "D88311",
  "password": "1234",         // 4-digit MPIN
  "totp": "456789"            // current 6-digit TOTP from authenticator app
}
```

`totp` is the *current* code derived from the QR seed — use a TOTP library:
```python
import pyotp
totp = pyotp.TOTP(seed).now()
```

### Response (success)
```json
{
  "status": true,
  "message": "SUCCESS",
  "errorcode": "",
  "data": {
    "jwtToken": "eyJ...",
    "refreshToken": "eyJ...",
    "feedToken": "eyJ..."
  }
}
```

### Response (failure)
`status: false` with `message` describing the issue. Common: `Invalid TOTP`, `Invalid Credentials`, `Account locked`.

## Refresh (`generateTokens`)

```
POST /rest/auth/angelbroking/jwt/v1/generateTokens
Body: { "refreshToken": "<refreshToken>" }
```
Returns a new `jwtToken` and `feedToken` in `data`. **Persist both.** The Python SDK's `generateToken(refresh_token)` does this and calls `setAccessToken()` and `setFeedToken()` together.

There's also `renewAccessToken` in the Python SDK which posts both `jwtToken` and `refreshToken`. The route is the same (`api.refresh` aliases to `api.token` → `/generateTokens`). Either form works.

## Profile

```
GET /rest/secure/angelbroking/user/v1/getProfile
Headers: <full set, including Authorization: Bearer ...>
Body: { "refreshToken": "<refreshToken>" }
```

Returns `data.clientcode`, `data.exchanges`, `data.products`, etc. The Python SDK calls this immediately after login to get the canonical client code.

## Logout

```
POST /rest/secure/angelbroking/user/v1/logout
Body: { "clientcode": "<clientCode>" }
```

## Required REST headers

Send all of these on every authenticated call. Missing or implausible values cause silent downgrades or 401/403.

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `Accept` | `application/json` |
| `Authorization` | `Bearer <jwtToken>` (omit only on `loginByPassword`) |
| `X-UserType` | `USER` |
| `X-SourceID` | `WEB` |
| `X-PrivateKey` | `<api_key>` (yes, this is just your API key) |
| `X-ClientLocalIP` | LAN IP of client |
| `X-ClientPublicIP` | Public/WAN IP of client |
| `X-MACAddress` | MAC of primary NIC, colon-separated, lowercase hex |

The Python SDK's hardcoded fallbacks if detection fails:
- `clientPublicIp = "106.193.147.98"`
- `clientLocalIp = "127.0.0.1"`

## Publisher (browser-redirect) login

For client-facing apps that don't have the user's password:
```
https://smartapi.angelone.in/publisher-login?api_key=<api_key>
```
The user logs in on Angel's portal; you receive an `auth_token` via your registered redirect URL. Then exchange via `generateTokens`.

## Session expiry

Detect 403 + `error_type: "TokenException"` in the response body. The Python SDK calls a registered `session_expiry_hook` in this case. Recommended pattern:
1. On 403/TokenException → call `generateTokens` with the stored `refreshToken`.
2. Replace the in-memory `jwtToken` and `feedToken`.
3. Reconnect any open SmartStream WebSocket (the old feedToken just got invalidated).
4. Retry the original request once.

If `refreshToken` itself is expired (~30d), full re-login (TOTP) is required — there's no silent path.
