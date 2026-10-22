import mongoose, { Schema, type Model, type Types } from "mongoose";
import type { Media } from "../types.js";
import { defaultSchemaOptions } from "./shared.js";

export interface MediaRecord {
  _id: Types.ObjectId;
  publicId: string;
  url: string;
  format: string;
  resourceType: Media["resourceType"];
  width: number;
  height: number;
  bytes: number;
  folder: string;
  alt: string;
  title: string;
  tags: string[];
  blurDataURL?: string;
  uploadedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const mediaSchema = new Schema<MediaRecord>(
  {
    publicId: { type: String, required: true, unique: true },
    url: { type: String, required: true },
    format: { type: String, default: "" },
    resourceType: { type: String, enum: ["image", "video", "raw"], default: "image" },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    bytes: { type: Number, default: 0 },
    folder: { type: String, default: "", trim: true },
    alt: { type: String, default: "" },
    title: { type: String, default: "" },
    tags: { type: [String], default: [] },
    blurDataURL: String,
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { ...defaultSchemaOptions, collection: "media" },
);

mediaSchema.index({ createdAt: -1 });
mediaSchema.index({ folder: 1, createdAt: -1 });
mediaSchema.index({ tags: 1 });

export const MediaModel: Model<MediaRecord> =
  (mongoose.models.Media as Model<MediaRecord> | undefined) ?? mongoose.model<MediaRecord>("Media", mediaSchema);
