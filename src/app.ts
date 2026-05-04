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

// Trust the first proxy (Cloudflare Tunnel)
app.set("trust proxy", 1);

// Apply rate limiting to all requests
app.use("/api", limiter);

// Security Headers (CSP)
app.use((_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://unpkg.com 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  );
  next();
});

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
