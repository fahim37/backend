import type { ErrorRequestHandler, RequestHandler } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import type { ApiError } from "../types.js";

type Normalized = { status: number; code: string; message: string; details?: unknown };

/** Flattened zod issues plus dotted paths, which forms can map back to nested fields. */
function zodDetails(error: z.ZodError) {
  const flat = z.flattenError(error);
  return {
    formErrors: flat.formErrors,
    fieldErrors: flat.fieldErrors,
    issues: error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message, code: issue.code })),
  };
}

function hasProp<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return typeof value === "object" && value !== null && key in value;
}

function normalize(error: unknown): Normalized | null {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof z.ZodError) {
    return { status: 422, code: "validation_error", message: "Some fields are invalid", details: zodDetails(error) };
  }
  if (error instanceof mongoose.Error.ValidationError) {
    const fieldErrors: Record<string, string[]> = {};
    for (const [path, issue] of Object.entries(error.errors)) fieldErrors[path] = [issue.message];
    return { status: 422, code: "validation_error", message: "Some fields are invalid", details: { formErrors: [], fieldErrors } };
  }
  if (error instanceof mongoose.Error.CastError) {
    return { status: 400, code: "bad_request", message: `Invalid value for "${error.path}"` };
  }
  if (hasProp(error, "code") && error.code === 11000) {
    const keyValue = hasProp(error, "keyValue") && error.keyValue && typeof error.keyValue === "object" ? error.keyValue : {};
    const fields = Object.keys(keyValue);
    const label = fields.length ? fields.join(", ") : "value";
    return {
      status: 409,
      code: "conflict",
      message: `Another item already uses this ${label}`,
      details: { fields, fieldErrors: Object.fromEntries(fields.map((field) => [field, ["Already in use"]])) },
    };
  }
  // body-parser / raw-body errors
  if (hasProp(error, "type") && typeof error.type === "string") {
    if (error.type === "entity.parse.failed") return { status: 400, code: "invalid_json", message: "Malformed JSON body" };
    if (error.type === "entity.too.large") return { status: 413, code: "payload_too_large", message: "Request body is too large" };
    if (error.type === "encoding.unsupported" || error.type === "charset.unsupported") {
      return { status: 415, code: "unsupported_media_type", message: "Unsupported request encoding" };
    }
  }
  // multer upload errors
  if (hasProp(error, "name") && error.name === "MulterError" && hasProp(error, "code")) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    return {
      status: tooLarge ? 413 : 400,
      code: tooLarge ? "payload_too_large" : "bad_request",
      message: error instanceof Error ? error.message : "Invalid upload",
    };
  }
  return null;
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const normalized = normalize(error);
  if (!normalized || normalized.status >= 500) {
    (req.log ?? logger).error({ err: error }, "unhandled error");
  }
  const { status, code, message, details } = normalized ?? {
    status: 500,
    code: "internal_error",
    message: "Something went wrong. Please try again.",
  };
  if (res.headersSent) {
    res.end();
    return;
  }
  const body: ApiError = { error: { message, code, ...(details !== undefined ? { details } : {}) } };
  res.status(status).json(body);
};

export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ApiError = { error: { message: `No route for ${req.method} ${req.path}`, code: "not_found" } };
  res.status(404).json(body);
};
