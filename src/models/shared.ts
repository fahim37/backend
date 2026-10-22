import { Schema, type SchemaOptions } from "mongoose";

const cropSchema = new Schema(
  { x: Number, y: Number, width: Number, height: Number },
  { _id: false },
);

const focalSchema = new Schema({ x: Number, y: Number }, { _id: false });

/** Embedded `CmsImage`. Validation happens in zod at the route boundary. */
export const imageSchema = new Schema(
  {
    url: { type: String, required: true },
    publicId: String,
    mediaId: String,
    width: Number,
    height: Number,
    alt: String,
    crop: { type: cropSchema, default: undefined },
    aspect: String,
    focal: { type: focalSchema, default: undefined },
  },
  { _id: false },
);

export const seoSchema = new Schema(
  {
    title: String,
    description: String,
    image: { type: imageSchema, default: undefined },
    noindex: Boolean,
    canonical: String,
    keywords: [String],
    priority: Number,
    changeFrequency: String,
  },
  { _id: false },
);

export const sectionSchema = new Schema({ heading: String, body: String }, { _id: false });

/** Fields every content document has. */
export const baseContentFields = {
  status: { type: String, enum: ["published", "draft"], default: "draft", required: true },
  order: { type: Number, default: 0, required: true },
  seo: { type: seoSchema, default: undefined },
} as const;

/** Removes internals from documents serialized with `toJSON`. */
function stripInternals(_doc: unknown, ret: Record<string, unknown>) {
  delete ret.__v;
  delete ret.passwordHash;
  return ret;
}

export const defaultSchemaOptions = {
  timestamps: true,
  versionKey: false,
  strict: true,
  toJSON: { transform: stripInternals },
  toObject: { transform: stripInternals },
} satisfies SchemaOptions;
