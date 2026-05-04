import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../utils/HttpError";
import logger from "../utils/logger";

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    logger.warn({ method: req.method, path: req.path, details }, "Validation failed");
    res.status(400).json({
      error: "ValidationError",
      message: "Request validation failed",
      details,
    });
    return;
  }

  if (error instanceof HttpError) {
    logger.warn({ method: req.method, path: req.path, err: error }, "Request failed");
    res.status(error.statusCode).json({
      error: error.name,
      message: error.message,
      details: error.details,
    });
    return;
  }

  logger.error({ method: req.method, path: req.path, err: error }, "Unexpected error");
  res.status(500).json({
    error: "InternalServerError",
    message: "An unexpected error occurred",
  });
};

export default errorHandler;
