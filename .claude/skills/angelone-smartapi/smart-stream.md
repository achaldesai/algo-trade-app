# SmartStream V2 — Binary Tick WebSocket

This is the **only** Angel One surface we use in this codebase. Get this right and ticks flow; get it wrong and the connection silently produces nothing.

## Endpoint

```
wss://smartapisocket.angelone.in/smart-stream
```

## Connection headers

Sent during the WebSocket HTTP handshake (NOT as a JSON message after open):

| Header | Value |
|---|---|
| `Authorization` | The raw `jwtToken` — **no `Bearer ` prefix** (per Python SDK `connect()`). If 4xx during handshake, try with `Bearer ` prefix; some Angel deployments accept either. |
| `x-api-key` | Your API key (same value as `X-PrivateKey` on REST) |
| `x-client-code` | Angel One client/account code (e.g., `D88311`) |
| `x-feed-token` | The `feedToken` from login or last `generateTokens` call |

**There is no separate post-open `authenticate` message.** Auth is done entirely via headers. Sending a JSON `{"action": "authenticate", ...}` after open is harmless but unnecessary; the server ignores it. Once the handshake succeeds, you can send `subscribe` immediately.

## Subscribe message (JSON, sent after WS open)

```json
{
  "correlationID": "abc123",
  "action": 1,
  "params": {
    "mode": 3,
    "tokenList": [
      { "exchangeType": 1, "tokens": ["3045", "881"] },
      { "exchangeType": 5, "tokens": ["234230"] }
    ]
  }
}
```

### Field rules — these are the most common bugs

- `action` is an **integer**: `1` = subscribe, `0` = unsubscribe. NOT the strings `"subscribe"` / `"unsubscribe"`.
- `mode` is an **integer**: `1` = LTP, `2` = Quote, `3` = SnapQuote, `4` = Depth (20-level, NSE_CM only). NOT `"FULL"`.
- `exchangeType` is an **integer code** (see table below). NOT the string `"NSE"`.
- `tokenList` is an **array of `{exchangeType, tokens}` objects** — tokens grouped per exchange. NOT a flat `tokens` array with a parallel `exchangeType` array.
- `tokens` are **strings**, even though they are numeric (e.g., `"3045"`, not `3045`).
- `correlationID` is optional (≤10 alphanumeric chars). Server echoes it in error responses for that subscription.

### Exchange type codes

| Code | Exchange / Segment |
|---|---|
| 1 | NSE_CM (NSE Cash Market) |
| 2 | NSE_FO (NSE F&O) |
| 3 | BSE_CM (BSE Cash Market) |
| 4 | BSE_FO (BSE F&O) |
| 5 | MCX_FO (MCX commodities) |
| 7 | NCX_FO (NCDEX commodities) |
| 13 | CDE_FO (Currency derivatives) |

### Subscription mode quotas

- **Depth (mode 4)** is restricted to NSE_CM (`exchangeType: 1`) ONLY, max **50 tokens** total per connection. Send Depth subscriptions for any other exchangeType and the SDK throws a `ValueError`; the server ignores or errors.
- **LTP / Quote / SnapQuote** have no client-side quota in the SDK. Server limits exist but are not published — be reasonable (≤500 tokens per connection is safe).

### Unsubscribe

```json
{
  "correlationID": "abc123",
  "action": 0,
  "params": {
    "mode": 3,
    "tokenList": [{ "exchangeType": 1, "tokens": ["3045"] }]
  }
}
```
Same shape as subscribe, just `action: 0`.

## Heartbeat

- Server sends WebSocket **ping frames** (control frames, not text). Reply with **pong** automatically (every standards-compliant client does this; `ws` for Node does it by default).
- Additionally, the SDK sends a text frame `"ping"` every 10 seconds and the server replies with text `"pong"`. Use the receipt of `"pong"` text as the liveness signal — if no pong in ~30s, the feed is dead and you should reconnect.

```js
ws.send("ping");                 // every 10s
// expect text frame "pong" back within ~10s
```

## Tick payload — binary format

Every market data frame is a **packed binary buffer** in **little-endian** byte order. NOT JSON. `JSON.parse(buffer.toString())` will throw or silently produce garbage. You MUST decode by byte offset.

### Header (common to all modes — first 51 bytes)

| Offset | Length | Type | Field | Notes |
|---|---|---|---|---|
| 0 | 1 | uint8 | subscription_mode | 1=LTP, 2=Quote, 3=SnapQuote, 4=Depth |
| 1 | 1 | uint8 | exchange_type | 1=NSE_CM, etc. |
| 2 | 25 | ASCII (null-terminated) | token | Read until first `\x00` byte |
| 27 | 8 | int64 LE | sequence_number | |
| 35 | 8 | int64 LE | exchange_timestamp | Epoch milliseconds |
| 43 | 8 | int64 LE | last_traded_price | **In paise — divide by 100 for ₹** |

For mode 1 (LTP), the packet ends here at byte 51.

### Quote / SnapQuote extension (mode 2 and mode 3 — bytes 51 to 123)

| Offset | Length | Type | Field | Notes |
|---|---|---|---|---|
| 51 | 8 | int64 LE | last_traded_quantity | |
| 59 | 8 | int64 LE | average_traded_price | **paise** |
| 67 | 8 | int64 LE | volume_trade_for_the_day | |
| 75 | 8 | float64 LE | total_buy_quantity | (note: `d` = double, not int) |
| 83 | 8 | float64 LE | total_sell_quantity | (note: `d` = double, not int) |
| 91 | 8 | int64 LE | open_price_of_the_day | **paise** |
| 99 | 8 | int64 LE | high_price_of_the_day | **paise** |
| 107 | 8 | int64 LE | low_price_of_the_day | **paise** |
| 115 | 8 | int64 LE | closed_price (prev close) | **paise** |

For mode 2 (Quote), the packet ends at byte 123.

### SnapQuote extension (mode 3 — bytes 123 to 379)

| Offset | Length | Type | Field | Notes |
|---|---|---|---|---|
| 123 | 8 | int64 LE | last_traded_timestamp | Epoch ms |
| 131 | 8 | int64 LE | open_interest | F&O only |
| 139 | 8 | int64 LE | open_interest_change_percentage | scaled — verify against feed |
| 147 | 200 | (10 packets × 20 bytes) | best_5_buy_and_sell_data | See below |
| 347 | 8 | int64 LE | upper_circuit_limit | **paise** |
| 355 | 8 | int64 LE | lower_circuit_limit | **paise** |
| 363 | 8 | int64 LE | 52_week_high_price | **paise** |
| 371 | 8 | int64 LE | 52_week_low_price | **paise** |

#### Best 5 buy/sell sub-packets (bytes 147–347)

10 packets of 20 bytes each. For each:

| Sub-offset | Length | Type | Field |
|---|---|---|---|
| 0 | 2 | uint16 LE | flag |
| 2 | 8 | int64 LE | quantity |
| 10 | 8 | int64 LE | price (**paise**) |
| 18 | 2 | uint16 LE | no_of_orders |

Bucket by `flag`. **Caveat from the Python SDK**: it stores `flag==0` packets in a "buy" bucket, then assigns that bucket to the `best_5_sell_data` output (and vice versa) — i.e., it swaps the buckets in the final output. This either means the on-wire convention is `flag==0 → sell, flag!=0 → buy`, or the SDK is wrong. **Verify against live data** (compare with REST `/market/v1/quote` for the same symbol) before trusting which side is which.

### Depth (mode 4) layout — bytes 0 to 443

Depth packets reuse the first 35 bytes of the standard header but rebuild from byte 35 onwards. Only available for NSE_CM (exchangeType 1).

| Offset | Length | Type | Field |
|---|---|---|---|
| 0 | 1 | uint8 | subscription_mode (=4) |
| 1 | 1 | uint8 | exchange_type (=1) |
| 2 | 25 | ASCII | token |
| 27 | 8 | int64 LE | sequence_number |
| 35 | 8 | int64 LE | packet_received_time |
| 43 | 200 | (20 packets × 10 bytes) | depth_20_buy_data |
| 243 | 200 | (20 packets × 10 bytes) | depth_20_sell_data |

Each 10-byte depth packet:

| Sub-offset | Length | Type | Field |
|---|---|---|---|
| 0 | 4 | int32 LE | quantity |
| 4 | 4 | int32 LE | price (**paise**, ÷100 for ₹) |
| 8 | 2 | int16 LE | num_of_orders |

Note depth uses **int32** and **int16** (4 / 2 bytes) — different from Quote/SnapQuote which use int64 / uint16. Don't reuse the same decoder.

## Reference TypeScript decoder

Save this for the actual fix in `AngelOneTickerService.ts`. Verified against the Python SDK's `_parse_binary_data`:

```ts
type TickMode = 1 | 2 | 3 | 4;

interface BaseTick {
  subscriptionMode: TickMode;
  exchangeType: number;
  token: string;
  sequenceNumber: bigint;
  exchangeTimestamp: bigint;
}

interface LtpTick extends BaseTick {
  subscriptionMode: 1;
  lastTradedPrice: number;     // ₹
}

interface QuoteTick extends BaseTick {
  subscriptionMode: 2 | 3;
  lastTradedPrice: number;     // ₹
  lastTradedQuantity: bigint;
  averageTradedPrice: number;  // ₹
  volumeForDay: bigint;
  totalBuyQuantity: number;
  totalSellQuantity: number;
  openPrice: number;           // ₹
  highPrice: number;           // ₹
  lowPrice: number;            // ₹
  prevClose: number;           // ₹
}

function parseTick(buf: Buffer): LtpTick | QuoteTick {
  const mode = buf.readUInt8(0) as TickMode;
  const exchangeType = buf.readUInt8(1);
  const token = parseToken(buf.subarray(2, 27));
  const sequenceNumber = buf.readBigInt64LE(27);
  const exchangeTimestamp = buf.readBigInt64LE(35);
  const lastTradedPrice = Number(buf.readBigInt64LE(43)) / 100;

  if (mode === 1) {
    return { subscriptionMode: 1, exchangeType, token, sequenceNumber, exchangeTimestamp, lastTradedPrice };
  }

  // mode 2 or 3 — share the Quote extension
  const tick: QuoteTick = {
    subscriptionMode: mode as 2 | 3,
    exchangeType,
    token,
    sequenceNumber,
    exchangeTimestamp,
    lastTradedPrice,
    lastTradedQuantity: buf.readBigInt64LE(51),
    averageTradedPrice: Number(buf.readBigInt64LE(59)) / 100,
    volumeForDay: buf.readBigInt64LE(67),
    totalBuyQuantity: buf.readDoubleLE(75),
    totalSellQuantity: buf.readDoubleLE(83),
    openPrice: Number(buf.readBigInt64LE(91)) / 100,
    highPrice: Number(buf.readBigInt64LE(99)) / 100,
    lowPrice: Number(buf.readBigInt64LE(107)) / 100,
    prevClose: Number(buf.readBigInt64LE(115)) / 100,
  };

  // mode 3 (SnapQuote) has more fields beyond byte 123 — extend here if needed.
  return tick;
}

function parseToken(slice: Buffer): string {
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("ascii");
}
```

For depth (mode 4), use `readInt32LE` for quantity/price and `readInt16LE` for `num_of_orders`. Don't forget `÷100` on the price.

## Error responses

The server sends a JSON text frame on subscription errors (NOT binary). Shape:
```json
{ "correlationID": "abc123", "errorCode": "<code>", "errorMessage": "<message>" }
```
Treat any text frame that's neither `"pong"` nor a binary tick as a potential error and log it. Don't `JSON.parse` blindly without first checking `Buffer.isBuffer(data)` or `typeof data === "string"`.

## Reconnection

Per Python SDK `_on_error`:
1. On any error or close, reconnect. Default delay 10s; with `retry_strategy=1` exponential `delay × multiplier^attempt`.
2. After reconnect, **resubscribe everything** the SDK had cached. The server does not remember your subscriptions across connections.
3. Cap attempts (Python SDK default: 1 attempt). For a long-running service, set higher (e.g., 10) and back off.

The current `AngelOneTickerService.ts` already has this skeleton — the bug is that it never closes because `_connected = true` is set unconditionally. Fix: only treat the connection as live after you receive the first message (any frame, including the first pong).

## Quick health check

If you ever doubt whether ticks are flowing, add a one-shot debug log:

```ts
this.ws.on("message", (data) => {
  logger.info(
    {
      isBuffer: Buffer.isBuffer(data),
      length: (data as Buffer).length,
      firstBytes: Buffer.isBuffer(data) ? (data as Buffer).subarray(0, 4).toString("hex") : data.toString().slice(0, 80),
    },
    "raw ws frame"
  );
  // ... existing handling
});
```

In a healthy market session you should see binary frames (`isBuffer: true`, length 51 / 123 / 379 / 443 depending on mode) every few hundred ms per subscribed symbol. If you only see text frames or nothing at all, your subscribe payload is wrong.
