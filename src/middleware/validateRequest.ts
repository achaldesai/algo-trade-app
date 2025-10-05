import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";

export const validateBody = <T>(schema: ZodSchema<T>): RequestHandler => {
  return (req, _res, next) => {
    try {
      const parsed = schema.parse(req.body);
      req.body = parsed as unknown as typeof req.body;
      next();
    } catch (error) {
      next(error);
    }
  };
};

export default validateBody;
