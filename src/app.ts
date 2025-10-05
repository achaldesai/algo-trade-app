import cors from "cors";
import express from "express";
import helmet from "helmet";
import env from "./config/env";
import errorHandler from "./middleware/errorHandler";
import notFoundHandler from "./middleware/notFound";
import requestLogger from "./middleware/requestLogger";
import stocksRouter from "./routes/stocks";
import tradesRouter from "./routes/trades";
import strategiesRouter from "./routes/strategies";
import marketDataRouter from "./routes/marketData";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

if (env.enableRequestLogging) {
  app.use(requestLogger);
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/stocks", stocksRouter);
app.use("/api/trades", tradesRouter);
app.use("/api/strategies", strategiesRouter);
app.use("/api/market-data", marketDataRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
