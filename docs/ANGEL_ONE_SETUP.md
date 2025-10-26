# Angel One SmartAPI Integration Guide

This guide explains how to set up and use Angel One's SmartAPI for **FREE** market data and trading in the algo-trade-app.

## Why Angel One?

Angel One provides **completely free** access to:
- ✅ Historical market data (OHLC candles)
- ✅ Real-time WebSocket ticker feeds
- ✅ Order execution APIs
- ✅ Market quotes and depth data

**Cost**: FREE market data + standard brokerage of ₹20 per executed order

**vs. Zerodha KiteConnect**: Charges ₹2000/month for market data APIs

---

## Prerequisites

1. **Angel One Trading Account**
   - Open an account at [angelone.in](https://www.angelone.in/)
   - Complete KYC verification

2. **SmartAPI Registration**
   - Visit [smartapi.angelbroking.com](https://smartapi.angelbroking.com/)
   - Register for API access
   - You'll receive an API Key

3. **Enable TOTP (Optional but Recommended)**
   - Install Google Authenticator or similar TOTP app
   - Link your Angel One account for 2FA
   - Save the TOTP secret for automatic authentication

---

## Step 1: Get Your API Credentials

1. Log in to [SmartAPI Portal](https://smartapi.angelbroking.com/)
2. Navigate to "API Key" section
3. Note down your:
   - **API Key** (e.g., `aBcD1234`)
   - **Client ID** (your Angel One client code)
   - **Password** (your Angel One password)

4. (Optional) Get TOTP Secret:
   - When setting up 2FA, save the QR code's secret key
   - Or use a TOTP library to extract it from the QR code

---

## Step 2: Configure Environment Variables

Update your `.env` file:

```bash
# Broker Configuration
BROKER_PROVIDER=angelone

# Angel One SmartAPI Credentials
ANGEL_ONE_API_KEY=your_api_key_here
ANGEL_ONE_CLIENT_ID=your_client_id_here
ANGEL_ONE_PASSWORD=your_password_here

# Angel One TOTP Secret (optional - for automatic 2FA)
# If not provided, you'll need to enter TOTP manually during login
ANGEL_ONE_TOTP_SECRET=your_totp_secret_here

# Angel One Trading Configuration
ANGEL_ONE_DEFAULT_EXCHANGE=NSE
ANGEL_ONE_PRODUCT_TYPE=DELIVERY  # Options: DELIVERY, INTRADAY, MARGIN, BO, CO
```

---

## Step 3: Authenticate with Angel One

### Method 1: Using API (with TOTP)

```bash
# If TOTP secret is set in .env, just call:
curl -X POST http://localhost:3000/api/auth/angelone/login \
  -H "Content-Type: application/json"

# If TOTP secret is NOT set, provide it manually:
curl -X POST http://localhost:3000/api/auth/angelone/login \
  -H "Content-Type: application/json" \
  -d '{"totp": "123456"}'
```

### Method 2: Programmatic Authentication

```typescript
import { SmartAPI } from "smartapi-javascript";

const smartApi = new SmartAPI({ api_key: "your_api_key" });

const response = await smartApi.generateSession(
  "your_client_id",
  "your_password",
  "123456" // TOTP code
);

console.log(response.data.jwtToken);
console.log(response.data.feedToken);
```

### Check Authentication Status

```bash
curl http://localhost:3000/api/auth/angelone/status
```

### Token Refresh

Angel One tokens expire daily at 5:00 AM IST. The application provides two ways to handle token refresh:

#### 1. Automatic Token Refresh (Recommended)

If you've configured `ANGEL_ONE_TOTP_SECRET`, the app automatically:
- Re-authenticates every day at 4:30 AM IST (before the 5 AM expiry)
- Uses TOTP for automatic 2FA
- Requires **no manual intervention**

The `TokenRefreshService` runs in the background and logs refresh activity.

#### 2. Manual Token Refresh

If you need to refresh the token mid-session (e.g., after a network interruption):

```bash
# Refresh the current token (keeps same expiry time)
curl -X POST http://localhost:3000/api/auth/angelone/refresh
```

**Note**: Manual refresh doesn't extend the expiry time. If the token has already expired, you'll need to re-login:

```bash
# Re-authenticate after expiry
curl -X POST http://localhost:3000/api/auth/angelone/login \
  -H "Content-Type: application/json"
```

### Logout

```bash
# Clear stored Angel One tokens
curl -X POST http://localhost:3000/api/auth/angelone/logout
```

---

## Step 4: Using Historical Data

Once authenticated, the app automatically uses Angel One for historical data:

```bash
# Fetch historical data for a symbol
curl http://localhost:3000/api/market-data/historical?symbol=RELIANCE&interval=1day&days=30
```

### Supported Intervals
- `1day` - Daily candles
- `1week` - Weekly candles
- `1month` - Monthly candles

---

## Step 5: Using Live WebSocket Ticker (Optional)

To enable live market data streaming:

```typescript
import AngelOneTickerService from "./services/AngelOneTickerService";
import { resolveMarketDataService } from "./container";

// Get token from authentication
const tokenData = await loadAngelToken();

const ticker = new AngelOneTickerService(
  {
    apiKey: env.angelOneApiKey,
    clientId: tokenData.clientId,
    jwtToken: tokenData.jwtToken,
    feedToken: tokenData.feedToken,
  },
  resolveMarketDataService()
);

await ticker.connect();

// Subscribe to symbols
ticker.subscribe({
  exchange: "NSE",
  symbolToken: "2885", // Token for RELIANCE
  symbol: "RELIANCE",
});
```

---

## Step 6: Trading with Angel One

Place orders using the standard trading engine:

```bash
# Place a buy order
curl -X POST http://localhost:3000/api/trades \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "RELIANCE",
    "side": "BUY",
    "quantity": 10,
    "type": "MARKET"
  }'
```

The app will automatically route orders to Angel One when `BROKER_PROVIDER=angelone`.

---

## Important Notes

### Symbol Tokens

Angel One uses **instrument tokens** instead of symbols. You need to:

1. Download the instrument master file:
   ```bash
   curl https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json > instruments.json
   ```

2. Implement symbol lookup in your code (marked with `TODO(human)` in the codebase):
   ```typescript
   // src/providers/AngelOneHistoricalProvider.ts:93
   // src/brokers/AngelOneBroker.ts:333
   ```

### TOTP Generation

If you want automatic TOTP generation, install `otplib`:

```bash
npm install otplib
```

Then implement the `generateTOTP()` method:

```typescript
import { authenticator } from "otplib";

private generateTOTP(secret: string): string {
  return authenticator.generate(secret);
}
```

### Token Expiry

Angel One JWT tokens expire after **24 hours**. The app handles this by:
- Storing tokens in `data/angelone-token.json`
- Checking expiry before each API call
- Re-authenticating automatically when needed

---

## Troubleshooting

### "TOTP is required" Error

**Solution**: Either:
1. Set `ANGEL_ONE_TOTP_SECRET` in `.env`, OR
2. Pass `totp` in the login request body

### "Invalid credentials or TOTP" Error

**Solution**:
- Verify your API Key, Client ID, and Password
- Ensure TOTP code is current (TOTP codes expire every 30 seconds)
- Check that your Angel One account is active

### "Symbol token lookup not implemented" Warning

**Solution**: Implement the symbol-to-token mapping:

1. Download instrument master
2. Parse and cache the mapping
3. Update `getSymbolToken()` method in:
   - `src/providers/AngelOneHistoricalProvider.ts`
   - `src/brokers/AngelOneBroker.ts`

### WebSocket Connection Issues

**Solution**:
- Ensure you have a valid `feedToken` from authentication
- Check that `ws` package is installed (`npm install ws @types/ws`)
- Verify firewall isn't blocking WebSocket connections

---

## API Reference

### Authentication Endpoints

#### POST `/api/auth/angelone/login`
Authenticate with Angel One SmartAPI

**Request Body**:
```json
{
  "totp": "123456"  // Optional if TOTP secret is in .env
}
```

**Response**:
```json
{
  "success": true,
  "message": "Authentication successful",
  "data": {
    "clientId": "A12345",
    "expiresAt": "2025-10-27T10:00:00.000Z",
    "jwtToken": "eyJ...",
    "feedToken": "abc123"
  }
}
```

#### GET `/api/auth/angelone/status`
Check authentication status

**Response**:
```json
{
  "authenticated": true,
  "clientId": "A12345",
  "expiresAt": "2025-10-27T10:00:00.000Z",
  "message": "Angel One session is active"
}
```

#### POST `/api/auth/angelone/logout`
Clear stored Angel One token

**Response**:
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

## Benefits of Angel One Integration

1. **Cost Savings**: FREE market data vs ₹2000/month for Zerodha
2. **Real-time Data**: WebSocket streaming for live tickers
3. **Historical Data**: Free access to OHLC candles
4. **Professional APIs**: Same quality as paid services
5. **Low Brokerage**: Only ₹20 per executed order

---

## Next Steps

1. ✅ Set up Angel One account and get API credentials
2. ✅ Configure environment variables
3. ✅ Authenticate via API
4. ✅ Test historical data fetching
5. ⏭️ Implement symbol token lookup
6. ⏭️ Enable WebSocket live ticker (optional)
7. ⏭️ Start trading!

---

## Support

- Angel One SmartAPI Docs: https://smartapi.angelbroking.com/docs
- Support: https://smartapi.angelbroking.com/support
- GitHub Issues: [Report integration issues here](https://github.com/angelbroking-github/smartapi-javascript/issues)

---

**Happy Trading! 🚀**
