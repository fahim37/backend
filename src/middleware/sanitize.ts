import type { RequestHandler } from "express";
import { stripMongoOperators } from "../lib/sanitize.js";

/**
 * Strips "$operator" and dotted keys from body, query and params. Express 5
 * exposes `req.query` as a getter, so the sanitized copy is defined as an own
 * property that shadows it for the rest of the request.
 */
export const sanitizeInput: RequestHandler = (req, _res, next) => {
  if (req.body && typeof req.body === "object") req.body = stripMongoOperators(req.body);
  const query = stripMongoOperators(req.query);
  Object.defineProperty(req, "query", { value: query, writable: true, configurable: true, enumerable: true });
  next();
};
