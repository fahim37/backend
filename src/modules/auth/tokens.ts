import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { CookieOptions, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import type { Role } from "../../types.js";

export const ACCESS_COOKIE = "srs_at";
export const REFRESH_COOKIE = "srs_rt";
export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export type AccessTokenClaims = { sub: string; sid: string; role: Role };

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign({ sid: claims.sid, role: claims.role }, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    subject: claims.sub,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: ACCESS_TTL_SECONDS,
  });
}

/** Returns the verified claims, or null for any invalid/expired token. */
export function verifyAccessToken(token: string): AccessTokenClaims | null {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ["HS256"],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    if (typeof payload === "string") return null;
    const { sub, sid, role } = payload as jwt.JwtPayload & { sid?: unknown; role?: unknown };
    if (typeof sub !== "string" || typeof sid !== "string" || typeof role !== "string") return null;
    return { sub, sid, role: role as Role };
  } catch {
    return null;
  }
}

/** Opaque, high-entropy refresh token; only its HMAC is persisted. */
export function generateRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return createHmac("sha256", env.JWT_REFRESH_SECRET).update(token).digest("hex");
}

export function newFamilyId(): string {
  return randomUUID();
}

function baseCookie(): CookieOptions {
  return { httpOnly: true, sameSite: "lax", secure: env.isProduction, path: "/" };
}

export function setAuthCookies(res: Response, tokens: { accessToken: string; refreshToken?: string }): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...baseCookie(), maxAge: ACCESS_TTL_SECONDS * 1000 });
  if (tokens.refreshToken) {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...baseCookie(), maxAge: REFRESH_TTL_SECONDS * 1000 });
  }
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, baseCookie());
  res.clearCookie(REFRESH_COOKIE, baseCookie());
}
