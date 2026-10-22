import mongoose, { Schema, type Model, type Types } from "mongoose";
import { ENQUIRY_STATUSES, type EnquiryStatus } from "../types.js";
import { defaultSchemaOptions } from "./shared.js";

export interface EnquiryNoteRecord {
  _id: Types.ObjectId;
  body: string;
  author: string;
  authorId?: Types.ObjectId | null;
  createdAt: Date;
}

export interface EnquiryRecord {
  _id: Types.ObjectId;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  service?: string;
  budget?: string;
  message: string;
  source?: string;
  status: EnquiryStatus;
  notes: EnquiryNoteRecord[];
  ip?: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const noteSchema = new Schema<EnquiryNoteRecord>(
  {
    body: { type: String, required: true },
    author: { type: String, required: true },
    authorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

const enquirySchema = new Schema<EnquiryRecord>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: String,
    company: String,
    service: String,
    budget: String,
    message: { type: String, required: true },
    source: String,
    status: { type: String, enum: ENQUIRY_STATUSES, default: "new", required: true },
    notes: { type: [noteSchema], default: [] },
    ip: String,
    userAgent: String,
  },
  { ...defaultSchemaOptions, collection: "enquiries" },
);

enquirySchema.index({ status: 1, createdAt: -1 });
enquirySchema.index({ createdAt: -1 });
enquirySchema.index({ email: 1 });

export const EnquiryModel: Model<EnquiryRecord> =
  (mongoose.models.Enquiry as Model<EnquiryRecord> | undefined) ?? mongoose.model<EnquiryRecord>("Enquiry", enquirySchema);
