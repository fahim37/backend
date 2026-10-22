import { env } from "../config/env.js";
import { hashPassword, UserModel } from "../models/user.js";
import { PASSWORD_MIN_LENGTH } from "../modules/auth/auth.schemas.js";
import { logger } from "./logger.js";

export type UpsertAdminResult = "created" | "updated" | "unchanged";

/**
 * Creates (or promotes) the admin account described by ADMIN_EMAIL /
 * ADMIN_PASSWORD / ADMIN_NAME. With `resetPassword`, an existing account also
 * gets the env password and is reactivated.
 */
export async function upsertAdminFromEnv({ resetPassword = false } = {}): Promise<UpsertAdminResult> {
  const email = env.ADMIN_EMAIL?.toLowerCase();
  const password = env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set");
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }

  const existing = await UserModel.findOne({ email }).select("+passwordHash");
  if (!existing) {
    await UserModel.create({ name: env.ADMIN_NAME, email, role: "admin", active: true, passwordHash: await hashPassword(password) });
    return "created";
  }

  let changed = false;
  if (existing.role !== "admin") {
    existing.role = "admin";
    changed = true;
  }
  if (resetPassword) {
    existing.passwordHash = await hashPassword(password);
    existing.passwordChangedAt = new Date();
    existing.active = true;
    changed = true;
  }
  if (changed) await existing.save();
  return changed ? "updated" : "unchanged";
}

/** On first boot (no users at all), creates the env admin so the CMS is reachable. */
export async function ensureBootstrapAdmin(): Promise<void> {
  if ((await UserModel.estimatedDocumentCount()) > 0) return;
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    logger.warn("no users exist and ADMIN_EMAIL/ADMIN_PASSWORD are not set; run `npm run create-admin` to add one");
    return;
  }
  try {
    await upsertAdminFromEnv();
    logger.info({ email: env.ADMIN_EMAIL.toLowerCase() }, "created initial admin user from environment");
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : error }, "could not create the initial admin user");
  }
}
