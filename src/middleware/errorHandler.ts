import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../utils/HttpError";
import logger from "../utils/logger";

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    logger.warn({ details }, "Validation failed");
    res.status(400).json({
      error: "ValidationError",
      message: "Request validation failed",
      details,
    });
    return;
  }

  if (error instanceof HttpError) {
    logger.warn({ err: error }, "Request failed");
    res.status(error.statusCode).json({
      error: error.name,
      message: error.message,
      details: error.details,
    });
    return;
  }

  logger.error({ err: error }, "Unexpected error");
  res.status(500).json({
    error: "InternalServerError",
    message: "An unexpected error occurred",
  });
};

export default errorHandler;
