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

import { rateLimit } from "express-rate-limit";

const app = express();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

app.use(express.json());
app.use(express.static("public"));

// Apply rate limiting to all requests
app.use("/api", limiter);

// Prevent 404 logs for favicon
app.get("/favicon.ico", (_req, res) => res.status(204).end());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRouter);
app.use("/api/stocks", stocksRouter);
app.use("/api/trades", tradesRouter);
app.use("/api/strategies", strategiesRouter);
app.use("/api/market-data", marketDataRouter);
app.use("/api/admin", adminRouter);
app.use("/api/control", controlRouter);
app.use("/api/reconciliation", reconciliationRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/stop-loss", stopLossRouter);
app.use("/api/pnl", pnlRouter);
app.use("/api/audit-logs", auditLogsRouter);
app.use("/api/notifications", notificationsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
