import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 does not catch promise rejections from async handlers: a `throw`
 * inside one becomes an unhandled rejection, which hangs the request and
 * crashes the process on Node >= 15. Wrap async handlers so errors reach
 * the error-handling middleware instead.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
