# Zerodha OAuth2 Authentication Setup

This guide explains how to set up Zerodha authentication for your algorithmic trading application.

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Environment Configuration](#environment-configuration)
3. [Authentication Flow](#authentication-flow)
4. [API Endpoints](#api-endpoints)
5. [Usage Examples](#usage-examples)
6. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### 1. Create a Zerodha Kite Connect App

1. Visit [Kite Connect](https://kite.trade/)
2. Create a new app or use an existing one
3. Note down:
   - **API Key** (used for authentication)
   - **API Secret** (used to exchange request token for access token)
4. Set the **Redirect URL** to your local application (e.g., `http://localhost:3000/callback` or any custom URL)

### 2. Install Dependencies

The application already has `kiteconnect@5.1.0` installed. No additional dependencies needed.

---

## Environment Configuration

Create or update your `.env` file with Zerodha credentials:

```bash
# Server Configuration
PORT=3000

# Broker Configuration
BROKER_PROVIDER=zerodha

# Zerodha API Credentials
ZERODHA_API_KEY=your_actual_api_key_here
ZERODHA_API_SECRET=your_actual_api_secret_here

# Zerodha Trading Configuration
ZERODHA_DEFAULT_EXCHANGE=NSE
ZERODHA_PRODUCT=CNC

# Other Configuration
PORTFOLIO_BACKEND=lmdb
DRY_RUN=false
MAX_POSITION_SIZE=100000
```

**Important Notes:**
- Replace `your_actual_api_key_here` and `your_actual_api_secret_here` with your actual credentials
- Do NOT commit `.env` file to git (it's already in `.gitignore`)
- The access token will be automatically saved after login

---

## Authentication Flow

Zerodha uses **OAuth2** authentication with the following flow:

```
┌─────────────┐         ┌──────────────┐         ┌──────────────┐
│             │         │              │         │              │
│   Your App  │────1────│  Zerodha    │         │   Zerodha    │
│             │         │  Login Page  │────2────│   Server     │
│             │         │              │         │              │
└──────┬──────┘         └──────────────┘         └──────┬───────┘
       │                                                 │
       │                3. Redirect with request_token  │
       │←────────────────────────────────────────────────┘
       │
       │                4. Exchange token
       ├────────────────────────────────────────────────►
       │
       │                5. Receive access_token
       │◄────────────────────────────────────────────────┤
       │
       └─────► Save token & use for API calls
```

### Step-by-Step Process:

1. **Get Login URL**: Call `GET /api/auth/zerodha/login`
2. **User Logs In**: Open the returned URL in a browser
3. **Redirect Callback**: After login, Zerodha redirects with `request_token`
4. **Exchange Token**: Call `POST /api/auth/zerodha/callback` with `request_token`
5. **Access Token Saved**: The access token is automatically saved to `data/zerodha-token.json`
6. **Auto-Load on Restart**: Token is automatically loaded when server restarts

---

## API Endpoints

### 1. Get Login URL
```http
GET /api/auth/zerodha/login
```

**Response:**
```json
{
  "loginUrl": "https://kite.zerodha.com/connect/login?api_key=your_key&v=3",
  "message": "Open this URL in your browser to login to Zerodha",
  "instructions": [
    "1. Open the loginUrl in your browser",
    "2. Login with your Zerodha credentials",
    "3. After successful login, you'll be redirected with a request_token",
    "4. Copy the request_token and call POST /api/auth/zerodha/callback with it"
  ]
}
```

---

### 2. Complete Authentication
```http
POST /api/auth/zerodha/callback
Content-Type: application/json

{
  "requestToken": "your_request_token_from_redirect"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Authentication successful",
  "data": {
    "userId": "AB1234",
    "userName": "Your Name",
    "email": "your@email.com",
    "expiresAt": "2025-10-20T00:30:00.000Z",
    "broker": "ZERODHA"
  }
}
```

**Token Expiry:**
- Zerodha access tokens expire at **6:00 AM IST** every day
- You need to re-authenticate daily

---

### 3. Check Authentication Status
```http
GET /api/auth/zerodha/status
```

**Response (authenticated):**
```json
{
  "authenticated": true,
  "isActive": true,
  "userId": "AB1234",
  "expiresAt": "2025-10-20T00:30:00.000Z",
  "message": "Zerodha session is active"
}
```

**Response (not authenticated):**
```json
{
  "authenticated": false,
  "message": "No active Zerodha session"
}
```

---

### 4. Get Current Token
```http
GET /api/auth/zerodha/token
```

**Response:**
```json
{
  "accessToken": "your_access_token_here",
  "expiresAt": "2025-10-20T00:30:00.000Z",
  "userId": "AB1234"
}
```

---

### 5. Logout
```http
POST /api/auth/zerodha/logout
```

**Response:**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

## Usage Examples

### Using curl

#### 1. Get Login URL
```bash
curl http://localhost:3000/api/auth/zerodha/login
```

#### 2. Complete Login (after getting request_token from browser)
```bash
curl -X POST http://localhost:3000/api/auth/zerodha/callback \
  -H "Content-Type: application/json" \
  -d '{"requestToken": "your_request_token_here"}'
```

#### 3. Check Status
```bash
curl http://localhost:3000/api/auth/zerodha/status
```

---

### Using Postman

1. Import the collection: `docs/algo-trade.postman_collection.json`
2. Navigate to **Authentication** folder
3. Follow the sequence:
   - Run "Get Zerodha Login URL"
   - Open the `loginUrl` in your browser
   - Login to Zerodha
   - Copy the `request_token` from the redirect URL
   - Run "Complete Zerodha Login" with the request token
   - Check status with "Check Auth Status"

---

### Using JavaScript/TypeScript

```typescript
// Example integration in your frontend or script

// Step 1: Get login URL
const loginResponse = await fetch('http://localhost:3000/api/auth/zerodha/login');
const { loginUrl } = await loginResponse.json();

// Step 2: User opens URL and logs in (manual step)
console.log('Open this URL:', loginUrl);

// Step 3: After redirect, extract request_token from URL
// URL will be: http://localhost:3000/callback?request_token=abc123&action=login&status=success
const urlParams = new URLSearchParams(window.location.search);
const requestToken = urlParams.get('request_token');

// Step 4: Exchange token
const authResponse = await fetch('http://localhost:3000/api/auth/zerodha/callback', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestToken })
});

const authData = await authResponse.json();
console.log('Authenticated:', authData);

// Step 5: Check status anytime
const statusResponse = await fetch('http://localhost:3000/api/auth/zerodha/status');
const status = await statusResponse.json();
console.log('Auth status:', status);
```

---

## Token Persistence

### Automatic Token Management

The application automatically handles token persistence:

1. **Save Location**: `data/zerodha-token.json`
2. **Auto-Load**: Token is loaded when server starts
3. **Environment Injection**: Token is injected into `process.env.ZERODHA_ACCESS_TOKEN`
4. **Broker Integration**: ZerodhaBroker automatically uses the loaded token

### Token File Structure

```json
{
  "accessToken": "your_access_token",
  "expiresAt": "2025-10-20T00:30:00.000Z",
  "userId": "AB1234",
  "apiKey": "your_api_key"
}
```

### Manual Token Management

If you prefer to manually manage tokens:

1. Set `ZERODHA_ACCESS_TOKEN` in your `.env` file
2. Skip the OAuth flow
3. Token must be valid (not expired)

```bash
# .env
ZERODHA_ACCESS_TOKEN=your_valid_access_token_here
```

---

## Troubleshooting

### Common Issues

#### 1. "Zerodha API key not configured"

**Solution:**
- Ensure `ZERODHA_API_KEY` is set in `.env`
- Restart the server after updating `.env`

#### 2. "Invalid or expired request token"

**Causes:**
- Request token was used more than once
- Request token expired (valid for ~5 minutes)
- Wrong API secret

**Solution:**
- Get a fresh login URL and request token
- Verify `ZERODHA_API_SECRET` is correct

#### 3. "Token expired" errors during trading

**Solution:**
- Zerodha tokens expire at 6 AM IST daily
- Re-authenticate using the login flow
- Consider implementing automatic re-authentication (see Advanced section)

#### 4. Server starts but broker doesn't connect

**Check:**
```bash
# View server logs
tail -f logs/app.log

# Check auth status
curl http://localhost:3000/api/auth/zerodha/status

# Verify environment
curl http://localhost:3000/api/admin/health
```

---

## Advanced: Automated Daily Re-Authentication

### Option 1: Scheduled Re-Authentication Script

Create `scripts/auth-zerodha.ts`:

```typescript
import { KiteConnect } from "kiteconnect";

async function authenticateDaily() {
  const apiKey = process.env.ZERODHA_API_KEY;
  const apiSecret = process.env.ZERODHA_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error("Missing Zerodha credentials");
  }

  // This would need to be automated with browser automation (Puppeteer/Playwright)
  // or by storing credentials (NOT RECOMMENDED for security)
  console.log("Daily re-authentication not fully automated for security reasons");
  console.log("Please manually re-authenticate each morning before market opens");
}

authenticateDaily();
```

### Option 2: Desktop Notification on Expiry

The application can notify you when the token is about to expire:

```bash
# Enable notifications in .env
ENABLE_NOTIFICATIONS=true
```

---

## Security Best Practices

1. **Never commit credentials**:
   - `.env` is in `.gitignore`
   - Token file `data/zerodha-token.json` should also be excluded

2. **Secure your `.env` file**:
   ```bash
   chmod 600 .env
   ```

3. **Use environment-specific credentials**:
   - Separate API keys for development and production
   - Consider using separate Zerodha accounts for testing

4. **Monitor API usage**:
   - Zerodha has rate limits
   - Check your API usage in Kite Connect dashboard

5. **Rotate secrets regularly**:
   - Generate new API keys periodically
   - Revoke old keys from Kite Connect dashboard

---

## Next Steps

After authentication is set up:

1. **Test with Paper Broker**: Set `BROKER_PROVIDER=paper` and `DRY_RUN=true`
2. **Test API connectivity**: Use `/api/admin/health` to verify broker connection
3. **Add Indian stocks**: Create stocks using `/api/stocks`
4. **Start trading**: Configure your strategies

---

## Support

- **Zerodha API Documentation**: https://kite.trade/docs/connect/v3/
- **KiteConnect SDK**: https://github.com/zerodhatech/kiteconnectjs
- **Application Issues**: Check `docs/TROUBLESHOOTING.md`

---

## Example: Complete Authentication Workflow

```bash
# Terminal Session Example

# 1. Start server
PORT=3001 npm start

# 2. Get login URL
curl -s http://localhost:3000/api/auth/zerodha/login | jq -r '.loginUrl'
# Output: https://kite.zerodha.com/connect/login?api_key=your_key&v=3

# 3. Open URL in browser (copy-paste the URL)
# After login, you'll be redirected to:
# http://localhost:3000/callback?request_token=abc123&action=login&status=success

# 4. Copy the request_token and exchange it
curl -X POST http://localhost:3000/api/auth/zerodha/callback \
  -H "Content-Type: application/json" \
  -d '{"requestToken": "abc123"}' | jq

# Output:
# {
#   "success": true,
#   "message": "Authentication successful",
#   "data": {
#     "userId": "AB1234",
#     "userName": "Your Name",
#     "email": "your@email.com",
#     "expiresAt": "2025-10-20T00:30:00.000Z"
#   }
# }

# 5. Verify authentication
curl -s http://localhost:3000/api/auth/zerodha/status | jq

# Output:
# {
#   "authenticated": true,
#   "isActive": true,
#   "userId": "AB1234",
#   "expiresAt": "2025-10-20T00:30:00.000Z"
# }

# 6. Your app is now ready to trade!
# The access token is automatically used by the ZerodhaBroker
```

---

## Summary

✅ OAuth2 authentication flow implemented
✅ Automatic token persistence
✅ Auto-load on server restart
✅ Daily expiry handling
✅ Secure credential management
✅ Complete API documentation
✅ Postman collection updated

Your Zerodha integration is now ready for Indian market trading! 🇮🇳📈
