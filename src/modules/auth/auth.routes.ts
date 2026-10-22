import { Router, type Request, type Response } from "express";
import { logActivity } from "../../lib/activity.js";
import { HttpError, notFound, unauthorized, unprocessable } from "../../lib/errors.js";
import { getAuth, requireAuth } from "../../middleware/auth.js";
import { authLimiter, loginLimiter } from "../../middleware/rate-limit.js";
import { validateBody } from "../../middleware/validate.js";
import { UserModel } from "../../models/user.js";
import { changePasswordSchema, loginSchema, updateMeSchema } from "./auth.schemas.js";
import { AuthFailure, changePassword, findPublicUser, login, logout, refresh } from "./auth.service.js";
import { ACCESS_COOKIE, clearAuthCookies, REFRESH_COOKIE, setAuthCookies, verifyAccessToken } from "./tokens.js";
import { Types } from "mongoose";
import type { z } from "zod";
import { isObjectIdString } from "../../lib/object-id.js";

export const authRouter = Router();

function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === "string" && value ? value : undefined;
}

function failAuth(res: Response, error: unknown): never {
  if (error instanceof AuthFailure) {
    if (error.reason !== "invalid_credentials") clearAuthCookies(res);
    const status = error.reason === "account_inactive" ? 403 : 401;
    throw new HttpError(status, error.reason, error.message);
  }
  throw error;
}

authRouter.post("/login", loginLimiter, validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body as z.output<typeof loginSchema>;
  try {
    const { user, tokens } = await login(email, password, req);
    setAuthCookies(res, tokens);
    await logActivity(user._id, { action: "login", entity: "users", entityId: user._id, label: user.email });
    res.json({ user });
  } catch (error) {
    failAuth(res, error);
  }
});

authRouter.post("/refresh", authLimiter, async (req, res) => {
  const token = readRefreshCookie(req);
  if (!token) {
    clearAuthCookies(res);
    throw unauthorized("Session expired", "refresh_invalid");
  }
  try {
    const { user, tokens } = await refresh(token, req);
    setAuthCookies(res, tokens);
    res.json({ user });
  } catch (error) {
    failAuth(res, error);
  }
});

authRouter.post("/logout", authLimiter, async (req, res) => {
  const token = readRefreshCookie(req);
  const accessCookie: unknown = req.cookies?.[ACCESS_COOKIE];
  const claims = !token && typeof accessCookie === "string" ? verifyAccessToken(accessCookie) : null;
  const sessionId = claims && isObjectIdString(claims.sid) ? new Types.ObjectId(claims.sid) : undefined;
  await logout(token, sessionId);
  clearAuthCookies(res);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await findPublicUser(getAuth(req).userId);
  if (!user) throw notFound("User not found");
  res.json({ user });
});

authRouter.patch("/me", requireAuth, validateBody(updateMeSchema), async (req, res) => {
  const input = req.body as z.output<typeof updateMeSchema>;
  const auth = getAuth(req);
  await UserModel.updateOne({ _id: auth.userId }, { $set: input });
  const user = await findPublicUser(auth.userId);
  if (!user) throw notFound("User not found");
  res.json({ user });
});

authRouter.post("/change-password", requireAuth, validateBody(changePasswordSchema), async (req, res) => {
  const { currentPassword, newPassword } = req.body as z.output<typeof changePasswordSchema>;
  const auth = getAuth(req);
  const changed = await changePassword(auth.userId, currentPassword, newPassword, auth.sessionId);
  if (!changed) {
    throw unprocessable("Current password is incorrect", {
      formErrors: [],
      fieldErrors: { currentPassword: ["Current password is incorrect"] },
    });
  }
  await logActivity(req, { action: "update", entity: "users", entityId: auth.userId, label: "Changed password" });
  res.json({ ok: true });
});
