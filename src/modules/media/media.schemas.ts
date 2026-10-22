import { z } from "zod";
import { paginationQuery } from "../../lib/pagination.js";
import { text } from "../../schemas/common.js";

export const DEFAULT_MEDIA_FOLDER = "library";
/**
 * Per-image size limit for both upload paths (multipart and direct). Matches
 * Cloudinary's free-plan cap (`media_limits.image_max_size_bytes` = 10 MB), so
 * users get our message instead of an opaque Cloudinary rejection. Keep in
 * sync with MAX_UPLOAD_BYTES in lib/admin/media.ts.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 20;

/** Image types accepted by the uploader (the contract's allow-list). */
export const ALLOWED_IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/pjpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

/** The same allow-list as Cloudinary format names (signed as `allowed_formats` for direct uploads). */
export const ALLOWED_IMAGE_FORMATS: readonly string[] = [...new Set(Object.values(ALLOWED_IMAGE_TYPES))];

/** Logical library folder: "library", "team", "blog/2026". Lowercase, path-like. */
export const folderSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(100)
  .transform((value) => value.replace(/\s+/g, "-").replace(/^\/+|\/+$/g, ""))
  .pipe(
    z
      .string()
      .min(1, "Required")
      .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/, "Use letters, numbers, hyphens and / only"),
  );

const tagSchema = z.string().trim().toLowerCase().min(1).max(50);

export const mediaListQuery = paginationQuery.extend({
  q: z.string().trim().max(200).optional(),
  folder: z.string().trim().toLowerCase().max(100).optional(),
  tag: z.string().trim().toLowerCase().max(50).optional(),
  format: z.string().trim().toLowerCase().max(20).optional(),
});

/** Multipart text fields sent alongside `files`. */
export const uploadFieldsSchema = z.object({
  folder: z.union([z.literal(""), folderSchema]).optional(),
  alt: text(500).optional(),
  tags: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) =>
      (Array.isArray(value) ? value : (value ?? "").split(","))
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    )
    .pipe(z.array(tagSchema).max(30)),
});

/** `POST /media/sign`: only the logical folder is client-chosen; every signed parameter is fixed server-side. */
export const signUploadSchema = z.object({
  folder: z.union([z.literal(""), folderSchema]).optional(),
});

/** `POST /media/register`: Cloudinary is the source of truth for every technical field. */
export const registerMediaSchema = z.object({
  publicId: z.string().trim().min(1, "Required").max(500),
  alt: text(500).optional(),
  title: text(200).optional(),
  /** Original file name, used for the title when `title` is omitted. */
  filename: text(255).optional(),
});

export type RegisterMediaInput = z.output<typeof registerMediaSchema>;

export const updateMediaSchema = z
  .object({
    alt: text(500),
    title: text(200),
    tags: z
      .array(tagSchema)
      .max(30)
      .transform((tags) => [...new Set(tags)]),
    folder: folderSchema,
  })
  .partial();

export const deleteMediaQuery = z.object({
  force: z
    .enum(["1", "true", "0", "false"])
    .optional()
    .transform((value) => value === "1" || value === "true"),
});

export type UpdateMediaInput = z.output<typeof updateMediaSchema>;
