import express from "express";
import errorHandler from "./middleware/errorHandler";
import notFoundHandler from "./middleware/notFound";
import stocksRouter from "./routes/stocks";
import tradesRouter from "./routes/trades";
import strategiesRouter from "./routes/strategies";
import marketDataRouter from "./routes/marketData";
import adminRouter from "./routes/admin";
import authRouter from "./routes/auth";
import controlRouter from "./routes/control";
import reconciliationRouter from "./routes/reconciliation";
import settingsRouter from "./routes/settings";
import stopLossRouter from "./routes/stopLoss";
import pnlRouter from "./routes/pnl";
import auditLogsRouter from "./routes/auditLogs";
import notificationsRouter from "./routes/notifications";
import scannerRouter from "./routes/scanner";
import usersRouter from "./routes/users";
import paperRouter, { paperModeOnly } from "./routes/paper";

import { rateLimit } from "express-rate-limit";
import helmet from "helmet";

const app = express();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10000, // Headroom for dashboard polling (~7 endpoints every 2s) plus manual API use
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Stricter rate limit for admin endpoints (60 req/min)
const adminLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  limit: 60,
  message: "Too many admin requests, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Brute-force protection for credential endpoints (per IP, failed attempts only for login)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  message: { success: false, error: "Too many attempts, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Trust the first proxy (Cloudflare Tunnel). Must be set before rate limiters
// run so they key on the client IP, not the tunnel's.
app.set("trust proxy", 1);

// Security headers. Applied before express.static so the dashboard HTML gets them too.
// CORS: intentionally no Access-Control-* headers — the dashboard is same-origin,
// so browsers block cross-origin reads by default.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://unpkg.com", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  // unpkg chart script is loaded cross-origin without CORP headers
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json());

// Gate the debug paper-trade console: only served in paper mode.
// Must run BEFORE express.static so the files are not exposed otherwise.
app.get(["/orders.html", "/orders.js"], paperModeOnly);

app.use(express.static("public", {
  setHeaders: (res, path) => {
    if (path.endsWith(".html") || path.endsWith(".js") || path.endsWith(".css")) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    }
  },
}));

// Apply rate limiting to all requests
app.use("/api", limiter);
app.use(["/api/users/login", "/api/users/register"], authLimiter);

// Prevent 404 logs for favicon
app.get("/favicon.ico", (_req, res) => res.status(204).end());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/users", usersRouter);
app.use("/api/auth", authRouter);
app.use("/api/stocks", stocksRouter);
app.use("/api/trades", tradesRouter);
app.use("/api/strategies", strategiesRouter);
app.use("/api/market-data", marketDataRouter);
// Apply strict limiter to admin routes
app.use("/api/admin", adminLimiter, adminRouter);
app.use("/api/control", controlRouter);
app.use("/api/reconciliation", reconciliationRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/stop-loss", stopLossRouter);
app.use("/api/pnl", pnlRouter);
app.use("/api/audit-logs", auditLogsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/scanner", scannerRouter);
app.use("/api/paper", paperRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
