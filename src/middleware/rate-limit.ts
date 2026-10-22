import type { Request } from "express";
import { ipKeyGenerator, rateLimit, type Options } from "express-rate-limit";
import { HttpError } from "../lib/errors.js";

const clientIp = (req: Request) => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown");

function limiter(options: Partial<Options> & { message: string }) {
  const { message, ...rest } = options;
  return rateLimit({
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: clientIp,
    handler: (_req, _res, next, opts) => {
      next(new HttpError(opts.statusCode, "rate_limited", message));
    },
    ...rest,
  });
}

/** 10 attempts per 15 minutes per IP + email. Successful logins do not count. */
export const loginLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const body: unknown = req.body;
    const email =
      body && typeof body === "object" && "email" in body && typeof body.email === "string"
        ? body.email.trim().toLowerCase()
        : "";
    return `${clientIp(req)}:${email}`;
  },
  message: "Too many sign-in attempts. Please wait a few minutes and try again.",
});

/** Refresh/logout traffic per IP. */
export const authLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  message: "Too many requests. Please slow down.",
});

/** 5 enquiries per 10 minutes per IP. */
export const enquiryLimiter = limiter({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  message: "Too many messages from your network. Please try again later.",
});

/** General ceiling for authenticated admin traffic. */
export const adminLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 600,
  message: "Too many requests. Please slow down.",
});
