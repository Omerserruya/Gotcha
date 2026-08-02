import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      // Reassign the PARSED value back onto req.body. Zod object schemas strip
      // unrecognized keys, so downstream handlers (and any `data: req.body`
      // Prisma sink) see only validated fields. Without this reassignment the
      // sanitized copy was discarded and attacker-supplied extra keys (role,
      // tenantId, authentikSubject, ...) flowed through unchecked (mass
      // assignment). Sinks additionally use explicit allowlists as defense in
      // depth.
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: "Validation failed",
          details: err.errors.map((e) => ({
            field: e.path.join("."),
            message: e.message,
          })),
        });
        return;
      }
      next(err);
    }
  };
}
