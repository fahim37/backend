import { Router, type Request } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { logActivity } from "../../lib/activity.js";
import { conflict, notFound } from "../../lib/errors.js";
import { requireObjectId } from "../../lib/object-id.js";
import { pageWindow, paginated, paginationQuery, parseSort } from "../../lib/pagination.js";
import { escapeRegex } from "../../lib/slug.js";
import { getAuth } from "../../middleware/auth.js";
import { parseBody, parseQuery } from "../../middleware/validate.js";
import { hashPassword, ROLES, USER_PUBLIC_FIELDS, UserModel } from "../../models/user.js";
import { cmsImageSchema } from "../../schemas/common.js";
import type { Role, User } from "../../types.js";
import { emailSchema, passwordSchema } from "../auth/auth.schemas.js";
import { revokeUserSessions, toPublicUser, type PublicUserSource } from "../auth/auth.service.js";

const roleSchema = z.enum(ROLES);

const listQuery = paginationQuery.extend({
  q: z.string().trim().max(200).optional(),
  role: roleSchema.optional(),
  active: z.enum(["true", "false"]).optional(),
  sort: z.string().trim().max(100).optional(),
});

const createUserSchema = z.object({
  name: z.string().trim().min(1, "Required").max(120),
  email: emailSchema,
  role: roleSchema.default("editor"),
  password: passwordSchema,
  active: z.boolean().default(true),
  avatar: cmsImageSchema.nullable().optional(),
});

const updateUserSchema = z.object({
  name: z.string().trim().min(1, "Required").max(120).optional(),
  email: emailSchema.optional(),
  role: roleSchema.optional(),
  /** Setting a password resets it and signs the user out everywhere. */
  password: passwordSchema.optional(),
  active: z.boolean().optional(),
  avatar: cmsImageSchema.nullable().optional(),
});

/** Users management. Mounted behind `requireAuth` + `requireRole("admin")`. */
export const usersRouter = Router();

async function loadUser(id: Types.ObjectId): Promise<User> {
  const user = await UserModel.findById(id).select(USER_PUBLIC_FIELDS).lean<PublicUserSource>();
  if (!user) throw notFound("User not found");
  return toPublicUser(user);
}

async function otherActiveAdmins(excludeId: Types.ObjectId): Promise<number> {
  return UserModel.countDocuments({ _id: { $ne: excludeId }, role: "admin", active: true });
}

/** Rejects changes that would leave the CMS without an active admin. */
async function assertKeepsAnAdmin(target: { _id: Types.ObjectId; role: Role; active: boolean }, next: { role: Role; active: boolean }) {
  const wasActiveAdmin = target.role === "admin" && target.active;
  const staysActiveAdmin = next.role === "admin" && next.active;
  if (wasActiveAdmin && !staysActiveAdmin && (await otherActiveAdmins(target._id)) === 0) {
    throw conflict("At least one active admin is required");
  }
}

function isSelf(req: Request, id: Types.ObjectId): boolean {
  return getAuth(req).userId.equals(id);
}

usersRouter.get("/", async (req, res) => {
  const query = parseQuery(listQuery, req);
  const filter: Record<string, unknown> = {};
  if (query.role) filter.role = query.role;
  if (query.active) filter.active = query.active === "true";
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), "i");
    filter.$or = [{ name: pattern }, { email: pattern }];
  }
  const sort = parseSort(query.sort, ["name", "email", "role", "createdAt", "lastLoginAt"], { createdAt: 1 });
  const { skip, limit } = pageWindow(query);
  const [items, total] = await Promise.all([
    UserModel.find(filter).select(USER_PUBLIC_FIELDS).sort(sort).skip(skip).limit(limit).lean<PublicUserSource[]>(),
    UserModel.countDocuments(filter),
  ]);
  res.json(paginated(items.map(toPublicUser), total, query));
});

usersRouter.get("/:id", async (req, res) => {
  res.json(await loadUser(requireObjectId(req.params.id, "User")));
});

usersRouter.post("/", async (req, res) => {
  const { password, ...input } = parseBody(createUserSchema, req);
  const created = await UserModel.create({ ...input, passwordHash: await hashPassword(password) });
  await logActivity(req, { action: "create", entity: "users", entityId: created._id, label: created.email });
  res.status(201).json(await loadUser(created._id));
});

usersRouter.patch("/:id", async (req, res) => {
  const id = requireObjectId(req.params.id, "User");
  const { password, ...changes } = parseBody(updateUserSchema, req);
  const target = await UserModel.findById(id).select("role active email");
  if (!target) throw notFound("User not found");

  const nextRole = changes.role ?? target.role;
  const nextActive = changes.active ?? target.active;
  if (isSelf(req, id) && (nextRole !== target.role || !nextActive)) {
    throw conflict("You cannot change your own role or deactivate yourself");
  }
  await assertKeepsAnAdmin(target, { role: nextRole, active: nextActive });

  const update: Record<string, unknown> = { ...changes };
  if (password) {
    update.passwordHash = await hashPassword(password);
    update.passwordChangedAt = new Date();
  }
  await UserModel.updateOne({ _id: id }, { $set: update }, { runValidators: true });

  const lostAccess = !nextActive || nextRole !== target.role || Boolean(password);
  if (lostAccess && !isSelf(req, id)) {
    await revokeUserSessions(id, password ? "password_reset" : "access_changed");
  } else if (password) {
    await revokeUserSessions(id, "password_reset", getAuth(req).sessionId);
  }

  const user = await loadUser(id);
  await logActivity(req, { action: "update", entity: "users", entityId: id, label: user.email });
  res.json(user);
});

usersRouter.delete("/:id", async (req, res) => {
  const id = requireObjectId(req.params.id, "User");
  if (isSelf(req, id)) throw conflict("You cannot delete your own account");
  const target = await UserModel.findById(id).select("role active email");
  if (!target) throw notFound("User not found");
  await assertKeepsAnAdmin(target, { role: "viewer", active: false });

  await UserModel.deleteOne({ _id: id });
  await revokeUserSessions(id, "user_deleted");
  await logActivity(req, { action: "delete", entity: "users", entityId: id, label: target.email });
  res.json({ ok: true });
});
