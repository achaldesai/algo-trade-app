# Angel One SmartAPI - Quick Start Guide

This guide gets you up and running with Angel One SmartAPI in **5 minutes** once you have your API credentials.

## ✅ What's Already Implemented

Your algo-trade-app now has **complete Angel One integration** including:
- ✅ Historical data provider (FREE OHLC data)
- ✅ Broker client for order execution
- ✅ WebSocket ticker service for live data
- ✅ Automatic symbol-to-token mapping
- ✅ Automatic TOTP generation for 2FA
- ✅ Authentication API endpoints
- ✅ Instrument master auto-download
- ✅ **Automatic daily token refresh** (no manual re-authentication needed!)

## 🚀 Quick Start (When You Have API Credentials)

### Step 1: Configure `.env` File

```bash
# Set broker to Angel One
BROKER_PROVIDER=angelone

# Add your Angel One credentials
ANGEL_ONE_API_KEY=your_api_key_here
ANGEL_ONE_CLIENT_ID=your_client_id_here
ANGEL_ONE_PASSWORD=your_password_here

# Optional: Add TOTP secret for automatic 2FA
ANGEL_ONE_TOTP_SECRET=your_totp_secret_here

# Trading configuration
ANGEL_ONE_DEFAULT_EXCHANGE=NSE
ANGEL_ONE_PRODUCT_TYPE=DELIVERY
```

### Step 2: Build & Start

```bash
# Build the project
npm run build

# Start the server
npm start
```

**What happens on startup:**
1. Server validates environment variables
2. **Automatically downloads** Angel One instrument master (~20MB JSON file)
3. Loads instrument data into memory for fast lookups
4. Ready to accept API requests!

### Step 3: Authenticate

#### Option A: With TOTP Secret (Fully Automatic)

If you set `ANGEL_ONE_TOTP_SECRET` in `.env`:

```bash
curl -X POST http://localhost:3000/api/auth/angelone/login
```

Done! The app automatically generates TOTP and authenticates.

#### Option B: Manual TOTP Entry

If you don't have the TOTP secret:

1. Open Google Authenticator (or your TOTP app)
2. Get the 6-digit code for Angel One
3. Call the API:

```bash
curl -X POST http://localhost:3000/api/auth/angelone/login \
  -H "Content-Type: application/json" \
  -d '{"totp": "123456"}'
```

**Response:**
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

### Step 4: Test Historical Data

```bash
# Fetch 30 days of RELIANCE daily candles
curl "http://localhost:3000/api/market-data/historical?symbol=RELIANCE&interval=1day&days=30"
```

### Step 5: Place Your First Order (Optional)

```bash
curl -X POST http://localhost:3000/api/trades \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "RELIANCE",
    "side": "BUY",
    "quantity": 1,
    "type": "MARKET"
  }'
```

---

## 📚 Key Features

### 1. **Automatic Symbol Token Mapping**

The app automatically:
- Downloads Angel One's instrument master file
- Caches symbol-to-token mappings in memory
- Handles NSE equity symbols with `-EQ` suffix
- Falls back to multiple naming conventions

**No manual token lookup needed!** Just use symbols like `"RELIANCE"` or `"TCS"`.

### 2. **Automatic TOTP Generation**

Set `ANGEL_ONE_TOTP_SECRET` once, and the app will:
- Generate TOTP codes automatically every 30 seconds
- Authenticate without manual intervention
- Perfect for automated trading

### 3. **Free Market Data**

Unlike Zerodha (₹2000/month), Angel One provides:
- ✅ FREE historical OHLC data
- ✅ FREE real-time WebSocket tickers
- ✅ FREE market quotes and depth
- Only pay ₹20 per executed trade

---

## 🔍 Verification Commands

### Check Authentication Status

```bash
curl http://localhost:3000/api/auth/angelone/status
```

### Search for Instruments

The instrument master is automatically loaded, so symbol lookups work seamlessly.

### Test Paper Trading First

```bash
# Switch to paper broker for testing
BROKER_PROVIDER=paper npm start
```

---

## 🛠️ Troubleshooting

### "Instrument master not loaded"

**Fix**: The server should auto-download it on startup. If it fails:

```bash
# Manually download
curl https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json \
  > data/angelone-instruments.json

# Restart server
npm start
```

### "TOTP is required"

**Fix**: Either:
1. Set `ANGEL_ONE_TOTP_SECRET` in `.env` for automatic generation
2. Pass `{"totp": "123456"}` in login request body

### "Symbol token not found for XYZ"

**Fix**: The symbol might need `-EQ` suffix for NSE equity:
- Try `"RELIANCE-EQ"` instead of `"RELIANCE"`
- Check symbol name in instrument master file

### Token Expired

Angel One tokens expire daily at 5:00 AM IST.

**Automatic Fix** (Recommended): If you set `ANGEL_ONE_TOTP_SECRET`, the app automatically re-authenticates at 4:30 AM IST every day. No manual intervention needed!

**Manual Fix**: Re-authenticate:

```bash
# Full re-authentication
curl -X POST http://localhost:3000/api/auth/angelone/login

# Or refresh existing token (keeps same expiry)
curl -X POST http://localhost:3000/api/auth/angelone/refresh
```

---

## 📖 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/angelone/login` | POST | Authenticate with Angel One |
| `/api/auth/angelone/status` | GET | Check auth status |
| `/api/auth/angelone/refresh` | POST | Refresh token (mid-session) |
| `/api/auth/angelone/logout` | POST | Clear session |
| `/api/market-data/historical` | GET | Fetch historical candles |
| `/api/trades` | POST | Place an order |
| `/api/trades` | GET | Get trade history |

---

## 🎯 Next Steps

1. ✅ Get Angel One API credentials
2. ✅ Configure `.env`
3. ✅ Start server
4. ✅ Authenticate
5. ✅ Test historical data
6. ⏭️ Build your trading strategy!
7. ⏭️ Enable WebSocket for live tickers (optional)
8. ⏭️ Start live trading

---

## 💡 Pro Tips

### Dry-Run Mode

Test your strategies without real trades:

```bash
DRY_RUN=true npm start
```

### Position Limits

Set maximum position size:

```bash
MAX_POSITION_SIZE=50000  # Max ₹50,000 per position
```

### Automatic Backups

LMDB database auto-backs up daily:

```bash
BACKUP_INTERVAL_HOURS=24  # Backup every 24 hours
```

---

## 🆘 Need Help?

- **Documentation**: See `docs/ANGEL_ONE_SETUP.md` for detailed setup
- **Issues**: Check logs in console for error messages
- **Angel One Support**: https://smartapi.angelbroking.com/support

---

**You're all set! Start trading with FREE market data from Angel One! 🚀**
