import type { Request } from "express";
import { Types } from "mongoose";
import { logger } from "../../lib/logger.js";
import { SessionModel, type SessionRecord } from "../../models/session.js";
import { hashPassword, USER_PUBLIC_FIELDS, UserModel, verifyPassword } from "../../models/user.js";
import type { User } from "../../types.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  newFamilyId,
  REFRESH_TTL_SECONDS,
  signAccessToken,
} from "./tokens.js";

/** Concurrent refreshes with the same token inside this window are treated as a benign race, not reuse. */
const ROTATION_GRACE_MS = 15_000;

export type IssuedTokens = { accessToken: string; refreshToken?: string };

export type PublicUserSource = {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: User["role"];
  avatar?: User["avatar"];
  active: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

/** The `User` shape returned by the API (password hash never included). */
export function toPublicUser(user: PublicUserSource): User {
  return {
    _id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    avatar: user.avatar ?? null,
    active: user.active,
    lastLoginAt: user.lastLoginAt?.toISOString(),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export async function findPublicUser(id: Types.ObjectId | string): Promise<User | null> {
  const user = await UserModel.findById(id).select(USER_PUBLIC_FIELDS).lean<PublicUserSource>();
  return user ? toPublicUser(user) : null;
}

// A real bcrypt hash compared against when the email is unknown, so failed
// logins take the same time whether or not the account exists.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(`timing-${Math.random()}`));

export class AuthFailure extends Error {
  constructor(
    readonly reason: "invalid_credentials" | "account_inactive" | "refresh_invalid" | "refresh_reused",
    message: string,
  ) {
    super(message);
    this.name = "AuthFailure";
  }
}

function clientMeta(req: Request) {
  return { ip: req.ip, userAgent: req.get("user-agent")?.slice(0, 400) };
}

async function createSession(userId: Types.ObjectId, familyId: string, req: Request, id = new Types.ObjectId()) {
  const refreshToken = generateRefreshToken();
  await SessionModel.create({
    _id: id,
    user: userId,
    familyId,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    lastUsedAt: new Date(),
    ...clientMeta(req),
  });
  return { sessionId: id, refreshToken };
}

export async function login(email: string, password: string, req: Request): Promise<{ user: User; tokens: IssuedTokens }> {
  const record = await UserModel.findOne({ email }).select("+passwordHash");
  const valid = await verifyPassword(password, record?.passwordHash ?? (await getDummyHash()));
  if (!record || !valid) throw new AuthFailure("invalid_credentials", "Invalid email or password");
  if (!record.active) throw new AuthFailure("account_inactive", "This account has been deactivated");

  const { sessionId, refreshToken } = await createSession(record._id, newFamilyId(), req);
  record.lastLoginAt = new Date();
  await record.save();

  const accessToken = signAccessToken({ sub: String(record._id), sid: String(sessionId), role: record.role });
  return { user: toPublicUser(record.toObject<PublicUserSource>()), tokens: { accessToken, refreshToken } };
}

async function revokeFamily(familyId: string, reason: string): Promise<void> {
  await SessionModel.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: reason } });
}

/**
 * Rotates a refresh token. Replaying an already-rotated token outside the
 * grace window is treated as theft and revokes every session of that login.
 */
export async function refresh(refreshToken: string, req: Request): Promise<{ user: User; tokens: IssuedTokens }> {
  const session = await SessionModel.findOne({ tokenHash: hashRefreshToken(refreshToken) }).lean<SessionRecord>();
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    throw new AuthFailure("refresh_invalid", "Session expired");
  }

  if (session.rotatedAt) return handleRotatedToken(session);

  const user = await UserModel.findById(session.user).select(USER_PUBLIC_FIELDS).lean<PublicUserSource>();
  if (!user || !user.active) {
    await revokeFamily(session.familyId, "user_inactive");
    throw new AuthFailure("account_inactive", "This account has been deactivated");
  }

  const successorId = new Types.ObjectId();
  const claimed = await SessionModel.findOneAndUpdate(
    { _id: session._id, rotatedAt: null, revokedAt: null },
    { $set: { rotatedAt: new Date(), replacedBy: successorId, lastUsedAt: new Date() } },
    { new: true },
  ).lean<SessionRecord>();
  // Another request rotated this token between our read and write.
  if (!claimed) {
    const latest = await SessionModel.findById(session._id).lean<SessionRecord>();
    if (!latest || latest.revokedAt) throw new AuthFailure("refresh_invalid", "Session expired");
    return handleRotatedToken(latest);
  }

  const next = await createSession(user._id, session.familyId, req, successorId);
  const accessToken = signAccessToken({ sub: String(user._id), sid: String(next.sessionId), role: user.role });
  return { user: toPublicUser(user), tokens: { accessToken, refreshToken: next.refreshToken } };
}

async function handleRotatedToken(session: SessionRecord): Promise<{ user: User; tokens: IssuedTokens }> {
  const rotatedAgo = Date.now() - (session.rotatedAt?.getTime() ?? 0);
  if (rotatedAgo <= ROTATION_GRACE_MS && session.replacedBy) {
    // Parallel refresh from another tab/request: the winner already set the new
    // refresh cookie, so only mint an access token bound to the successor.
    const [successor, user] = await Promise.all([
      SessionModel.findById(session.replacedBy).lean<SessionRecord>(),
      UserModel.findById(session.user).select(USER_PUBLIC_FIELDS).lean<PublicUserSource>(),
    ]);
    if (successor && !successor.revokedAt && user?.active) {
      const accessToken = signAccessToken({ sub: String(user._id), sid: String(successor._id), role: user.role });
      return { user: toPublicUser(user), tokens: { accessToken } };
    }
  }
  await revokeFamily(session.familyId, "refresh_reuse");
  logger.warn({ userId: String(session.user), familyId: session.familyId }, "refresh token reuse detected; session family revoked");
  throw new AuthFailure("refresh_reused", "Session expired");
}

/** Revokes the login (session family) behind a refresh token and/or session id. */
export async function logout(refreshToken: string | undefined, sessionId: Types.ObjectId | undefined): Promise<void> {
  const session = refreshToken
    ? await SessionModel.findOne({ tokenHash: hashRefreshToken(refreshToken) }).select("familyId").lean()
    : sessionId
      ? await SessionModel.findById(sessionId).select("familyId").lean()
      : null;
  if (session) await revokeFamily(session.familyId, "logout");
}

/** Revokes every session of a user, optionally keeping the family of `keepSessionId`. */
export async function revokeUserSessions(userId: Types.ObjectId, reason: string, keepSessionId?: Types.ObjectId): Promise<void> {
  let keepFamily: string | undefined;
  if (keepSessionId) {
    const current = await SessionModel.findById(keepSessionId).select("familyId").lean();
    keepFamily = current?.familyId;
  }
  await SessionModel.updateMany(
    { user: userId, revokedAt: null, ...(keepFamily ? { familyId: { $ne: keepFamily } } : {}) },
    { $set: { revokedAt: new Date(), revokeReason: reason } },
  );
}

export async function changePassword(
  userId: Types.ObjectId,
  currentPassword: string,
  newPassword: string,
  currentSessionId: Types.ObjectId,
): Promise<boolean> {
  const record = await UserModel.findById(userId).select("+passwordHash");
  if (!record || !(await verifyPassword(currentPassword, record.passwordHash))) return false;
  record.passwordHash = await hashPassword(newPassword);
  record.passwordChangedAt = new Date();
  await record.save();
  await revokeUserSessions(userId, "password_changed", currentSessionId);
  return true;
}
