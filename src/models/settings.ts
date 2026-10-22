import mongoose, { Schema, type Model, type Types } from "mongoose";
import { defaultSchemaOptions } from "./shared.js";

export interface SettingsRecord {
  _id: Types.ObjectId;
  key: string;
  /** Validated against the zod schema for `key` at the route boundary. */
  data: Record<string, unknown>;
  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const settingsSchema = new Schema<SettingsRecord>(
  {
    key: { type: String, required: true, unique: true, trim: true },
    data: { type: Schema.Types.Mixed, required: true, default: {} },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { ...defaultSchemaOptions, collection: "settings", minimize: false },
);

export const SettingsModel: Model<SettingsRecord> =
  (mongoose.models.Settings as Model<SettingsRecord> | undefined) ?? mongoose.model<SettingsRecord>("Settings", settingsSchema);
