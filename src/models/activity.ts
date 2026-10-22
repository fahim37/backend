import mongoose, { Schema, type Model, type Types } from "mongoose";
import type { Activity } from "../types.js";

export type ActivityAction = Activity["action"];

export const ACTIVITY_ACTIONS = [
  "create",
  "update",
  "delete",
  "publish",
  "unpublish",
  "reorder",
  "upload",
  "login",
  "settings",
  "revalidate",
] as const satisfies readonly ActivityAction[];

/** Audit entries are kept for one year. */
const RETENTION_SECONDS = 365 * 24 * 60 * 60;

export interface ActivityRecord {
  _id: Types.ObjectId;
  user?: Types.ObjectId | null;
  action: ActivityAction;
  entity: string;
  entityId?: string;
  label?: string;
  createdAt: Date;
}

const activitySchema = new Schema<ActivityRecord>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, enum: ACTIVITY_ACTIONS, required: true },
    entity: { type: String, required: true },
    entityId: String,
    label: String,
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: "activities" },
);

activitySchema.index({ entity: 1, createdAt: -1 });
activitySchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

export const ActivityModel: Model<ActivityRecord> =
  (mongoose.models.Activity as Model<ActivityRecord> | undefined) ?? mongoose.model<ActivityRecord>("Activity", activitySchema);
