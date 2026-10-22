import bcrypt from "bcryptjs";
import mongoose, { Schema, type Model, type Types } from "mongoose";
import type { CmsImage, Role } from "../types.js";
import { defaultSchemaOptions, imageSchema } from "./shared.js";

export const ROLES = ["admin", "editor", "viewer"] as const satisfies readonly Role[];
export const BCRYPT_COST = 12;

export interface UserRecord {
  _id: Types.ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  avatar?: CmsImage | null;
  active: boolean;
  lastLoginAt?: Date;
  passwordChangedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserRecord>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    // Never selected unless explicitly requested with "+passwordHash".
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: "editor", required: true },
    avatar: { type: imageSchema, default: null },
    active: { type: Boolean, default: true },
    lastLoginAt: Date,
    passwordChangedAt: Date,
  },
  { ...defaultSchemaOptions, collection: "users" },
);

userSchema.index({ role: 1, active: 1 });

export const UserModel: Model<UserRecord> =
  (mongoose.models.User as Model<UserRecord> | undefined) ?? mongoose.model<UserRecord>("User", userSchema);

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Public projection of a user; never includes the password hash. */
export const USER_PUBLIC_FIELDS = "name email role avatar active lastLoginAt createdAt updatedAt";
