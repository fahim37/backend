import path from "node:path";
import type { Request } from "express";
import type { Types } from "mongoose";
import type { z } from "zod";
import { logActivity } from "../../lib/activity.js";
import { notifyContentChanged } from "../../lib/content-events.js";
import { conflict, HttpError, notFound, unprocessable } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { pageWindow, paginated } from "../../lib/pagination.js";
import { escapeRegex, slugify } from "../../lib/slug.js";
import { MediaModel, type MediaRecord } from "../../models/media.js";
import type { Media, Paginated } from "../../types.js";
import {
  cloudinaryFolder,
  createBlurDataUrl,
  destroyAsset,
  findImageResource,
  getCloudinary,
  imageUploadUrl,
  pathBelowMediaRoot,
  signUploadParams,
  toCloudinaryHttpError,
  uploadBuffer,
  type CloudinaryResource,
} from "./cloudinary.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  ALLOWED_IMAGE_FORMATS,
  DEFAULT_MEDIA_FOLDER,
  folderSchema,
  MAX_UPLOAD_BYTES,
  type mediaListQuery,
  type RegisterMediaInput,
  type UpdateMediaInput,
} from "./media.schemas.js";
import { scanMediaUsage, type MediaUsage } from "./media.usage.js";

const UPLOAD_CONCURRENCY = 3;
/** Cloudinary accepts a signed upload for one hour after its timestamp. */
const SIGNATURE_TTL_SECONDS = 60 * 60;
const MAX_UPLOAD_LABEL = `${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`;

export type UploadFile = { originalname: string; mimetype: string; buffer: Buffer; size: number };
export type UploadOptions = { folder?: string; alt?: string; tags?: string[] };

/** JSON-safe Media (ObjectIds → strings, Dates → ISO). */
export function toMediaJson(doc: unknown): Media {
  return JSON.parse(JSON.stringify(doc)) as Media;
}

/** "hero_banner-final.webp" → "Hero banner final". */
export function titleFromFilename(filename: string): string {
  const base = path.parse(filename).name.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "Untitled image";
}

/** Cloudinary-safe file name that keeps the extension. */
function safeFilename(filename: string): string {
  const { name, ext } = path.parse(filename);
  return `${slugify(name, 80) || "image"}${ext.toLowerCase()}`;
}

async function findMedia(id: Types.ObjectId): Promise<MediaRecord> {
  const doc = await MediaModel.findById(id).lean<MediaRecord>();
  if (!doc) throw notFound("Media not found");
  return doc;
}

export async function listMedia(query: z.output<typeof mediaListQuery>): Promise<Paginated<Media>> {
  const filter: Record<string, unknown> = {};
  if (query.folder) filter.folder = new RegExp(`^${escapeRegex(query.folder)}(?:/|$)`);
  if (query.tag) filter.tags = query.tag;
  if (query.format) filter.format = query.format;
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), "i");
    filter.$or = [{ title: pattern }, { alt: pattern }, { publicId: pattern }, { tags: pattern }];
  }
  const { skip, limit } = pageWindow(query);
  const [items, total] = await Promise.all([
    MediaModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    MediaModel.countDocuments(filter),
  ]);
  return paginated(items.map(toMediaJson), total, query);
}

/** Distinct folders in use (plus the default upload folder), alphabetically. */
export async function listFolders(): Promise<string[]> {
  const folders = (await MediaModel.distinct("folder")) as string[];
  return [...new Set([DEFAULT_MEDIA_FOLDER, ...folders.filter(Boolean)])].sort((a, b) => a.localeCompare(b));
}

export async function getMedia(id: Types.ObjectId): Promise<Media> {
  return toMediaJson(await findMedia(id));
}

/**
 * Uploads every file to Cloudinary and records it. All-or-nothing: if any
 * file fails, the ones already stored are removed again and the error is
 * returned, so the library never holds half of a batch.
 */
export async function uploadMedia(files: UploadFile[], options: UploadOptions, req: Request): Promise<Media[]> {
  if (files.length === 0) {
    throw unprocessable("Choose at least one image to upload", { fieldErrors: { files: ["Required"] }, formErrors: [] });
  }
  getCloudinary(); // 503 before doing any work when uploads are not configured

  const folder = options.folder || DEFAULT_MEDIA_FOLDER;
  type Outcome = { ok: true; doc: MediaRecord } | { ok: false; file: string; error: unknown };
  const outcomes = await mapWithConcurrency(files, UPLOAD_CONCURRENCY, async (file): Promise<Outcome> => {
    try {
      return { ok: true, doc: await uploadOne(file, folder, options, req) };
    } catch (error) {
      return { ok: false, file: file.originalname, error };
    }
  });

  const uploaded = outcomes.flatMap((outcome) => (outcome.ok ? [outcome.doc] : []));
  const failures = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome]));
  if (failures.length > 0) {
    await Promise.all(uploaded.map((doc) => removeStoredMedia(doc)));
    const first = failures[0]!;
    const mapped = toCloudinaryHttpError(first.error, "The image could not be uploaded");
    throw new HttpError(mapped.status, mapped.code, `${first.file}: ${mapped.message}`, {
      failed: failures.map(({ file, error }) => ({ file, message: toCloudinaryHttpError(error).message })),
    });
  }

  notifyContentChanged();
  await logActivity(req, {
    action: "upload",
    entity: "media",
    entityId: uploaded.length === 1 ? uploaded[0]!._id : undefined,
    label: uploaded.length === 1 ? uploaded[0]!.title : `${uploaded.length} images`,
  });
  return uploaded.map(toMediaJson);
}

async function uploadOne(file: UploadFile, folder: string, options: UploadOptions, req: Request): Promise<MediaRecord> {
  const result = await uploadBuffer(file.buffer, {
    folder: cloudinaryFolder(folder),
    use_filename: true,
    unique_filename: true,
    filename_override: safeFilename(file.originalname),
    overwrite: false,
    tags: options.tags?.length ? options.tags : undefined,
  });

  try {
    return await recordAsset(
      { ...result, format: result.format ?? path.extname(file.originalname).slice(1), bytes: result.bytes ?? file.size },
      { folder, alt: options.alt, title: titleFromFilename(file.originalname), tags: options.tags },
      req,
    );
  } catch (error) {
    await destroyAsset(result.public_id).catch((cleanupError: unknown) =>
      logger.error({ err: cleanupError, publicId: result.public_id }, "could not remove orphaned Cloudinary asset"),
    );
    throw error;
  }
}

type RecordOptions = { folder: string; title: string; alt?: string; tags?: string[] };

/**
 * Stores a Cloudinary asset in the library, with its blur placeholder. Every
 * technical field (URL, size, dimensions, format) comes from Cloudinary.
 */
async function recordAsset(asset: CloudinaryResource, options: RecordOptions, req: Request): Promise<MediaRecord> {
  const blurDataURL = await createBlurDataUrl(asset.public_id);
  const created = await MediaModel.create({
    publicId: asset.public_id,
    url: asset.secure_url,
    format: (asset.format ?? "").toLowerCase(),
    resourceType: asset.resource_type === "video" || asset.resource_type === "raw" ? asset.resource_type : "image",
    width: asset.width ?? 0,
    height: asset.height ?? 0,
    bytes: asset.bytes ?? 0,
    folder: options.folder,
    alt: options.alt ?? "",
    title: options.title,
    tags: options.tags ?? [],
    blurDataURL,
    uploadedBy: req.auth?.userId ?? null,
  });
  return created.toObject<MediaRecord>();
}

/** What the browser needs for one signed direct upload (`POST /media/sign`). */
export type DirectUploadSignature = {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  /** Full Cloudinary folder the upload lands in, e.g. "srsit/library". */
  folder: string;
  uploadUrl: string;
  maxBytes: number;
  allowedFormats: string[];
  /** Every form field to post to `uploadUrl` verbatim, next to `file`. */
  fields: Record<string, string>;
  expiresAt: string;
};

/**
 * Signs one direct browser → Cloudinary upload. The signed parameter set is
 * fixed here, mirroring the multipart path (unique file names, no overwrite,
 * the image allow-list); the client only picks the logical folder, which is
 * validated by `folderSchema` and always lands under CLOUDINARY_FOLDER.
 */
export function createUploadSignature(folder: string | undefined): DirectUploadSignature {
  const target = cloudinaryFolder(folder || DEFAULT_MEDIA_FOLDER);
  const timestamp = Math.floor(Date.now() / 1000);
  const params: Record<string, string> = {
    allowed_formats: ALLOWED_IMAGE_FORMATS.join(","),
    folder: target,
    overwrite: "false",
    timestamp: String(timestamp),
    unique_filename: "true",
    use_filename: "true",
  };
  const { signature, apiKey, cloudName } = signUploadParams(params);
  return {
    cloudName,
    apiKey,
    timestamp,
    signature,
    folder: target,
    uploadUrl: imageUploadUrl(),
    maxBytes: MAX_UPLOAD_BYTES,
    allowedFormats: [...ALLOWED_IMAGE_FORMATS],
    fields: { ...params, api_key: apiKey, signature },
    expiresAt: new Date((timestamp + SIGNATURE_TTL_SECONDS) * 1000).toISOString(),
  };
}

const outsideMediaRoot = () =>
  new HttpError(403, "forbidden", `Only images uploaded to the "${cloudinaryFolder("")}" Cloudinary folder can be added to the library`);

/**
 * An asset that cannot be registered is removed again when it is recent, i.e.
 * a direct upload that just failed validation. Older assets are left alone.
 */
async function discardFailedUpload(resource: CloudinaryResource): Promise<void> {
  const createdAt = resource.created_at ? Date.parse(resource.created_at) : Number.NaN;
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > SIGNATURE_TTL_SECONDS * 1000) return;
  await destroyAsset(resource.public_id).catch((error: unknown) =>
    logger.error({ err: error, publicId: resource.public_id }, "could not remove a rejected direct upload"),
  );
}

/**
 * Adds an image that the browser uploaded straight to Cloudinary to the
 * library. Idempotent by public id: registering again returns the existing
 * record (`created: false`). The asset must exist, be an allowed image within
 * the size limit and live under CLOUDINARY_FOLDER; its URL, size, dimensions
 * and format are read from the Cloudinary Admin API, never from the client.
 */
export async function registerMedia(input: RegisterMediaInput, req: Request): Promise<{ media: Media; created: boolean }> {
  const below = pathBelowMediaRoot(input.publicId);
  if (!below?.length) throw outsideMediaRoot();

  const existing = await MediaModel.findOne({ publicId: input.publicId }).lean<MediaRecord>();
  if (existing) return { media: toMediaJson(existing), created: false };

  const resource = await findImageResource(input.publicId);
  if (!resource || (resource.resource_type ?? "image") !== "image") {
    throw notFound("No uploaded image was found on Cloudinary for this public id");
  }
  if (resource.public_id !== input.publicId) throw outsideMediaRoot();
  if (resource.asset_folder !== undefined && pathBelowMediaRoot(resource.asset_folder) === null) throw outsideMediaRoot();

  const format = (resource.format ?? "").toLowerCase();
  if (!ALLOWED_IMAGE_FORMATS.includes(format)) {
    await discardFailedUpload(resource);
    throw new HttpError(415, "unsupported_media_type", `${format ? `"${format}" files are` : "That file is"} not a supported image. Use JPEG, PNG, WebP, AVIF, GIF or SVG.`);
  }
  if ((resource.bytes ?? 0) > MAX_UPLOAD_BYTES) {
    await discardFailedUpload(resource);
    throw new HttpError(413, "payload_too_large", `Images can be at most ${MAX_UPLOAD_LABEL} each. Compress or resize the file and try again.`);
  }

  const folder = folderSchema.safeParse(below.slice(0, -1).join("/")).data ?? DEFAULT_MEDIA_FOLDER;
  // Without a client file name, "hero-banner_x1y2z3" → "hero-banner" (drops Cloudinary's unique suffix).
  const title = input.title || titleFromFilename(input.filename || (below.at(-1) ?? "").replace(/_[a-z0-9]{6}$/, ""));

  let doc: MediaRecord;
  try {
    doc = await recordAsset(resource, { folder, alt: input.alt, title }, req);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 11000) {
      const raced = await MediaModel.findOne({ publicId: input.publicId }).lean<MediaRecord>();
      if (raced) return { media: toMediaJson(raced), created: false };
    }
    await discardFailedUpload(resource);
    throw error;
  }

  notifyContentChanged();
  await logActivity(req, { action: "upload", entity: "media", entityId: doc._id, label: doc.title || doc.publicId });
  return { media: toMediaJson(doc), created: true };
}

async function removeStoredMedia(doc: MediaRecord): Promise<void> {
  try {
    await destroyAsset(doc.publicId, doc.resourceType);
    await MediaModel.deleteOne({ _id: doc._id });
  } catch (error) {
    logger.error({ err: error, publicId: doc.publicId }, "could not roll back an uploaded image");
  }
}

export async function updateMedia(id: Types.ObjectId, input: UpdateMediaInput, req: Request): Promise<Media> {
  const updated = await MediaModel.findByIdAndUpdate(id, { $set: input }, { new: true, runValidators: true }).lean();
  if (!updated) throw notFound("Media not found");
  notifyContentChanged();
  await logActivity(req, { action: "update", entity: "media", entityId: id, label: updated.title || updated.publicId });
  return toMediaJson(updated);
}

export async function getMediaUsage(id: Types.ObjectId): Promise<MediaUsage[]> {
  const doc = await findMedia(id);
  return scanMediaUsage({ id: doc._id.toString(), publicId: doc.publicId, url: doc.url });
}

/**
 * Deletes the Cloudinary asset and the library record. Referenced media is
 * refused with 409 (details.usage lists the references) unless `force`.
 */
export async function deleteMedia(id: Types.ObjectId, force: boolean, req: Request): Promise<{ usage: MediaUsage[] }> {
  const doc = await findMedia(id);
  const usage = await scanMediaUsage({ id: doc._id.toString(), publicId: doc.publicId, url: doc.url });
  if (usage.length > 0 && !force) {
    const count = usage.length;
    throw conflict(`This image is used in ${count} place${count === 1 ? "" : "s"}. Remove it there first or delete anyway.`, { usage });
  }

  try {
    await destroyAsset(doc.publicId, doc.resourceType);
  } catch (error) {
    throw toCloudinaryHttpError(error, "Cloudinary could not delete the file");
  }
  await MediaModel.deleteOne({ _id: doc._id });

  notifyContentChanged();
  await logActivity(req, { action: "delete", entity: "media", entityId: id, label: doc.title || doc.publicId });
  return { usage };
}
