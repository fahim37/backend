import type { Request, RequestHandler } from "express";
import type { z } from "zod";

/** Replaces `req.body` with the parsed output of `schema` (422 on failure). */
export function validateBody<S extends z.ZodType>(schema: S): RequestHandler {
  return (req, _res, next) => {
    req.body = schema.parse(req.body ?? {});
    next();
  };
}

/** Parses `req.query` with `schema`; throws a ZodError (422) on failure. */
export function parseQuery<S extends z.ZodType>(schema: S, req: Request): z.output<S> {
  return schema.parse(req.query);
}

/** Parses an already-read value with `schema`; throws a ZodError (422) on failure. */
export function parseBody<S extends z.ZodType>(schema: S, req: Request): z.output<S> {
  return schema.parse(req.body ?? {});
}
