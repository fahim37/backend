export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation_error"
  | "payload_too_large"
  | "rate_limited"
  | "internal_error"
  | "service_unavailable"
  | (string & {});

/** An error that maps directly to an HTTP response of the `ApiError` shape. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = "Bad request", details?: unknown) =>
  new HttpError(400, "bad_request", message, details);
export const unauthorized = (message = "Authentication required", code: ErrorCode = "unauthorized") =>
  new HttpError(401, code, message);
export const forbidden = (message = "You do not have permission to do that") =>
  new HttpError(403, "forbidden", message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const conflict = (message = "Conflict", details?: unknown) => new HttpError(409, "conflict", message, details);
export const unprocessable = (message: string, details?: unknown) =>
  new HttpError(422, "validation_error", message, details);
