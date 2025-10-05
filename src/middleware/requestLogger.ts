import type { RequestHandler } from "express";
import logger from "../utils/logger";

export const requestLogger: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    logger.info(
      {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Number(duration.toFixed(3)),
      },
      "HTTP request completed",
    );
  });

  next();
};

export default requestLogger;
