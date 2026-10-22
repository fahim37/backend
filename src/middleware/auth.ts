import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Types } from "mongoose";
import { forbidden, unauthorized } from "../lib/errors.js";
import { SessionModel } from "../models/session.js";
import { UserModel } from "../models/user.js";
import { ACCESS_COOKIE, verifyAccessToken } from "../modules/auth/tokens.js";
import type { Role } from "../types.js";

export type AuthContext = {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  name: string;
  email: string;
  role: Role;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireAuth`. */
      auth?: AuthContext;
    }
  }
}

function readAccessToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim() || null;
  const cookie: unknown = req.cookies?.[ACCESS_COOKIE];
  return typeof cookie === "string" && cookie ? cookie : null;
}

/**
 * Authenticates the request from the `srs_at` cookie or a Bearer token. The
 * user and session are re-checked on every request so deactivation, role
 * changes and logout take effect immediately.
 */
export const requireAuth: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
  const token = readAccessToken(req);
  if (!token) throw unauthorized();

  const claims = verifyAccessToken(token);
  if (!claims || !Types.ObjectId.isValid(claims.sub) || !Types.ObjectId.isValid(claims.sid)) {
    throw unauthorized("Session expired", "token_invalid");
  }

  const [user, session] = await Promise.all([
    UserModel.findById(claims.sub).select("name email role active").lean(),
    SessionModel.findById(claims.sid).select("user revokedAt expiresAt").lean(),
  ]);

  if (!user || !user.active) throw unauthorized("Account unavailable", "account_inactive");
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now() || !session.user.equals(user._id)) {
    throw unauthorized("Session expired", "session_revoked");
  }

  req.auth = { userId: user._id, sessionId: session._id, name: user.name, email: user.email, role: user.role };
  next();
};

/** Allows the request only for the listed roles. Use after `requireAuth`. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw unauthorized();
    if (!roles.includes(req.auth.role)) throw forbidden();
    next();
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Viewers may read; any other method needs an editor or admin. Use after `requireAuth`. */
export const requireWriteAccess: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.auth) throw unauthorized();
  if (req.auth.role === "viewer") throw forbidden("Your role is read-only");
  next();
};

/** Narrowing helper for handlers mounted behind `requireAuth`. */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
