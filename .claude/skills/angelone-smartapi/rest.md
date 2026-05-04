# REST API Reference

Base URL: `https://apiconnect.angelone.in`

All routes below take the auth header set described in `auth.md`. Bodies are JSON. Responses follow this envelope:
```json
{ "status": true, "message": "SUCCESS", "errorcode": "", "data": { ... } }
```
On error, `status: false`, `message` explains, `errorcode` may be set.

## Auth (see `auth.md` for full details)

| Route | Method | Notes |
|---|---|---|
| `/rest/auth/angelbroking/user/v1/loginByPassword` | POST | TOTP login |
| `/rest/auth/angelbroking/jwt/v1/generateTokens` | POST | Refresh JWT + feedToken |
| `/rest/secure/angelbroking/user/v1/getProfile` | GET | Profile |
| `/rest/secure/angelbroking/user/v1/logout` | POST | Logout |

## Orders

### Place order
```
POST /rest/secure/angelbroking/order/v1/placeOrder
```
Body:
```json
{
  "variety": "NORMAL",
  "tradingsymbol": "SBIN-EQ",
  "symboltoken": "3045",
  "transactiontype": "BUY",
  "exchange": "NSE",
  "ordertype": "LIMIT",
  "producttype": "INTRADAY",
  "duration": "DAY",
  "price": "19500",
  "squareoff": "0",
  "stoploss": "0",
  "quantity": "1"
}
```
Response: `data.orderid` (string). The SDK's `placeOrder` returns just the orderid; `placeOrderFullResponse` returns the full envelope.

#### Field enums
- **variety**: `NORMAL` | `STOPLOSS` | `AMO` | `ROBO` (bracket order)
- **transactiontype**: `BUY` | `SELL`
- **exchange**: `NSE` | `BSE` | `NFO` | `BFO` | `MCX` | `CDS` | `NCDEX`
- **ordertype**: `MARKET` | `LIMIT` | `STOPLOSS_LIMIT` | `STOPLOSS_MARKET`
- **producttype**: `DELIVERY` (CNC) | `INTRADAY` (MIS) | `MARGIN` (NRML) | `CARRYFORWARD` | `BO` (bracket) | `CO` (cover)
- **duration**: `DAY` | `IOC`

For `STOPLOSS_LIMIT` / `STOPLOSS_MARKET`, also send `triggerprice`. For `ROBO` / bracket, send `squareoff` (target points) and `stoploss` (SL points).

### Modify order
```
POST /rest/secure/angelbroking/order/v1/modifyOrder
```
Body: same shape as placeOrder plus `orderid`. Only mutable fields are honored.

### Cancel order
```
POST /rest/secure/angelbroking/order/v1/cancelOrder
Body: { "variety": "NORMAL", "orderid": "<orderid>" }
```

### Order book / Trade book / Order details
```
GET /rest/secure/angelbroking/order/v1/getOrderBook
GET /rest/secure/angelbroking/order/v1/getTradeBook
GET /rest/secure/angelbroking/order/v1/details/<orderid>      // appends orderid to path
```

`getOrderBook` returns all orders for the day (status: `complete`/`open`/`cancelled`/`rejected`). Use `details/<orderid>` for a single order.

## Portfolio

| Route | Method | Returns |
|---|---|---|
| `/rest/secure/angelbroking/order/v1/getPosition` | GET | Day's positions (intraday + carryforward) |
| `/rest/secure/angelbroking/portfolio/v1/getHolding` | GET | T+2 holdings |
| `/rest/secure/angelbroking/portfolio/v1/getAllHolding` | GET | Holdings + total summary |
| `/rest/secure/angelbroking/user/v1/getRMS` | GET | RMS / margin / available cash |
| `/rest/secure/angelbroking/order/v1/convertPosition` | POST | Convert MIS↔CNC etc. |

`convertPosition` body:
```json
{
  "exchange": "NSE",
  "oldproducttype": "DELIVERY",
  "newproducttype": "MARGIN",
  "tradingsymbol": "SBIN-EQ",
  "symboltoken": "3045",
  "transactiontype": "BUY",
  "quantity": 1,
  "type": "DAY"
}
```

## Market data

### LTP (single symbol)
```
POST /rest/secure/angelbroking/order/v1/getLtpData
Body: { "exchange": "NSE", "tradingsymbol": "SBIN-EQ", "symboltoken": "3045" }
```

### Multi-symbol quote
```
POST /rest/secure/angelbroking/market/v1/quote
Body:
{
  "mode": "FULL",                                      // or "OHLC", "LTP"
  "exchangeTokens": { "NSE": ["3045", "881"], "BSE": ["500325"] }
}
```

### Search scrip
```
POST /rest/secure/angelbroking/order/v1/searchScrip
Body: { "exchange": "NSE", "searchscrip": "SBIN" }
```

## Historical data

```
POST /rest/secure/angelbroking/historical/v1/getCandleData
Body:
{
  "exchange": "NSE",
  "symboltoken": "3045",
  "interval": "ONE_MINUTE",
  "fromdate": "2021-02-08 09:00",     // "YYYY-MM-DD HH:MM" in IST
  "todate":   "2021-02-08 09:16"
}
```

Valid `interval` values:
- `ONE_MINUTE`, `THREE_MINUTE`, `FIVE_MINUTE`, `TEN_MINUTE`, `FIFTEEN_MINUTE`, `THIRTY_MINUTE`
- `ONE_HOUR`
- `ONE_DAY`

Response `data` is an array of arrays:
```
[ [timestamp, open, high, low, close, volume], ... ]
```
Timestamps are ISO-8601 in IST with offset (e.g., `"2021-02-08T09:00:00+05:30"`).

### Open Interest history
```
POST /rest/secure/angelbroking/historical/v1/getOIData
```
Same body shape; OI for F&O symbols.

## GTT (Good Till Triggered)

| Route | Method |
|---|---|
| `/gtt-service/rest/secure/angelbroking/gtt/v1/createRule` | POST |
| `/gtt-service/rest/secure/angelbroking/gtt/v1/modifyRule` | POST |
| `/gtt-service/rest/secure/angelbroking/gtt/v1/cancelRule` | POST |
| `/rest/secure/angelbroking/gtt/v1/ruleDetails` | POST |
| `/rest/secure/angelbroking/gtt/v1/ruleList` | POST |

Note that create/modify/cancel live under `/gtt-service/...` while details/list are under `/rest/...`.

Create body:
```json
{
  "tradingsymbol": "SBIN-EQ",
  "symboltoken": "3045",
  "exchange": "NSE",
  "producttype": "MARGIN",
  "transactiontype": "BUY",
  "price": 100000,
  "qty": 10,
  "disclosedqty": 10,
  "triggerprice": 200000,
  "timeperiod": 365
}
```
Returns `data.id` — the GTT rule id.

`ruleList` body: `{ "status": ["FORALL"], "page": 1, "count": 10 }`. Status MUST be a list. Other status values: `NEW`, `CANCELLED`, `ACTIVE`, `SENTTOEXCHANGE`, `FORALL`, `EXPIRED`, `DISABLED`.

## Margin / Charges / EDIS

| Route | Method | Purpose |
|---|---|---|
| `/rest/secure/angelbroking/margin/v1/batch` | POST | Margin requirement for a basket of orders |
| `/rest/secure/angelbroking/brokerage/v1/estimateCharges` | POST | Brokerage + tax estimator |
| `/rest/secure/angelbroking/edis/v1/verifyDis` | POST | Verify e-DIS for selling demat holdings |
| `/rest/secure/angelbroking/edis/v1/generateTPIN` | POST | Trigger CDSL TPIN OTP |
| `/rest/secure/angelbroking/edis/v1/getTranStatus` | POST | Check e-DIS transaction status |

## Market intelligence (free analytics endpoints)

| Route | Method |
|---|---|
| `/rest/secure/angelbroking/marketData/v1/optionGreek` | POST |
| `/rest/secure/angelbroking/marketData/v1/gainersLosers` | POST |
| `/rest/secure/angelbroking/marketData/v1/putCallRatio` | GET |
| `/rest/secure/angelbroking/marketData/v1/OIBuildup` | POST |
| `/rest/secure/angelbroking/marketData/v1/nseIntraday` | GET |
| `/rest/secure/angelbroking/marketData/v1/bseIntraday` | GET |

## Rate limits

Per Angel One's published `RateLimit` doc (typical figures):

| Endpoint class | Per second | Per minute | Per hour |
|---|---|---|---|
| Order place | 20 | 500 | 1000 |
| Order modify | 20 | 500 | 1000 |
| Order cancel | 20 | 500 | 1000 |
| Order book | 1 | 5 | 10000 |
| Trade book | 1 | 5 | 10000 |
| RMS | 2 | 100 | 5000 |
| Profile | 1 | 5 | — |
| LTP / quote | 10 | 500 | 5000 |
| Historical (candle) | 3 | 180 | 5000 |
| Search scrip | 1 | 5 | — |

Verify against the live RateLimit doc page when you ship — they tweak these. 429 means rate limited; back off and retry with jitter.

## Reference: route → SDK alias

For grepping the Python SDK source (`smartConnect.py:_routes`):

| Alias | Path |
|---|---|
| `api.login` | `/rest/auth/angelbroking/user/v1/loginByPassword` |
| `api.logout` | `/rest/secure/angelbroking/user/v1/logout` |
| `api.token` / `api.refresh` | `/rest/auth/angelbroking/jwt/v1/generateTokens` |
| `api.user.profile` | `/rest/secure/angelbroking/user/v1/getProfile` |
| `api.order.place` | `/rest/secure/angelbroking/order/v1/placeOrder` |
| `api.order.modify` | `/rest/secure/angelbroking/order/v1/modifyOrder` |
| `api.order.cancel` | `/rest/secure/angelbroking/order/v1/cancelOrder` |
| `api.order.book` | `/rest/secure/angelbroking/order/v1/getOrderBook` |
| `api.trade.book` | `/rest/secure/angelbroking/order/v1/getTradeBook` |
| `api.individual.order.details` | `/rest/secure/angelbroking/order/v1/details/` |
| `api.ltp.data` | `/rest/secure/angelbroking/order/v1/getLtpData` |
| `api.market.data` | `/rest/secure/angelbroking/market/v1/quote` |
| `api.search.scrip` | `/rest/secure/angelbroking/order/v1/searchScrip` |
| `api.rms.limit` | `/rest/secure/angelbroking/user/v1/getRMS` |
| `api.holding` | `/rest/secure/angelbroking/portfolio/v1/getHolding` |
| `api.allholding` | `/rest/secure/angelbroking/portfolio/v1/getAllHolding` |
| `api.position` | `/rest/secure/angelbroking/order/v1/getPosition` |
| `api.convert.position` | `/rest/secure/angelbroking/order/v1/convertPosition` |
| `api.candle.data` | `/rest/secure/angelbroking/historical/v1/getCandleData` |
| `api.oi.data` | `/rest/secure/angelbroking/historical/v1/getOIData` |
| `api.gtt.create` | `/gtt-service/rest/secure/angelbroking/gtt/v1/createRule` |
| `api.gtt.modify` | `/gtt-service/rest/secure/angelbroking/gtt/v1/modifyRule` |
| `api.gtt.cancel` | `/gtt-service/rest/secure/angelbroking/gtt/v1/cancelRule` |
| `api.gtt.details` | `/rest/secure/angelbroking/gtt/v1/ruleDetails` |
| `api.gtt.list` | `/rest/secure/angelbroking/gtt/v1/ruleList` |
| `api.margin.api` | `/rest/secure/angelbroking/margin/v1/batch` |
| `api.estimateCharges` | `/rest/secure/angelbroking/brokerage/v1/estimateCharges` |
| `api.verifyDis` | `/rest/secure/angelbroking/edis/v1/verifyDis` |
| `api.generateTPIN` | `/rest/secure/angelbroking/edis/v1/generateTPIN` |
| `api.getTranStatus` | `/rest/secure/angelbroking/edis/v1/getTranStatus` |
| `api.optionGreek` | `/rest/secure/angelbroking/marketData/v1/optionGreek` |
| `api.gainersLosers` | `/rest/secure/angelbroking/marketData/v1/gainersLosers` |
| `api.putCallRatio` | `/rest/secure/angelbroking/marketData/v1/putCallRatio` |
| `api.oIBuildup` | `/rest/secure/angelbroking/marketData/v1/OIBuildup` |
| `api.nseIntraday` | `/rest/secure/angelbroking/marketData/v1/nseIntraday` |
| `api.bseIntraday` | `/rest/secure/angelbroking/marketData/v1/bseIntraday` |
