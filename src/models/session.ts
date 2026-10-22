import mongoose, { Schema, type Model, type Types } from "mongoose";

/**
 * A refresh-token session. Only an HMAC of the opaque refresh token is stored.
 * Each refresh rotates the token: the old row is marked `rotatedAt` and points
 * at its successor via `replacedBy`; all rows of one login share `familyId`, so
 * replaying a rotated token can revoke the whole family.
 */
export interface SessionRecord {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  rotatedAt?: Date | null;
  replacedBy?: Types.ObjectId | null;
  revokedAt?: Date | null;
  revokeReason?: string | null;
  lastUsedAt?: Date;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<SessionRecord>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    rotatedAt: { type: Date, default: null },
    replacedBy: { type: Schema.Types.ObjectId, ref: "Session", default: null },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, default: null },
    lastUsedAt: Date,
    ip: String,
    userAgent: String,
  },
  { timestamps: true, versionKey: false, collection: "sessions" },
);

// MongoDB removes expired sessions automatically.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionModel: Model<SessionRecord> =
  (mongoose.models.Session as Model<SessionRecord> | undefined) ?? mongoose.model<SessionRecord>("Session", sessionSchema);
