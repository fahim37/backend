import { Router, type RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import multer from "multer";
import { HttpError } from "../../lib/errors.js";
import { requireObjectId } from "../../lib/object-id.js";
import { parseBody, parseQuery } from "../../middleware/validate.js";
import {
  ALLOWED_IMAGE_TYPES,
  deleteMediaQuery,
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_BYTES,
  mediaListQuery,
  registerMediaSchema,
  signUploadSchema,
  updateMediaSchema,
  uploadFieldsSchema,
} from "./media.schemas.js";
import {
  createUploadSignature,
  deleteMedia,
  getMedia,
  getMediaUsage,
  listFolders,
  listMedia,
  registerMedia,
  updateMedia,
  uploadMedia,
  type UploadFile,
} from "./media.service.js";

/** Accepted multipart file field names ("files" per the contract; "files[]"/"file" for convenience). */
const FILE_FIELDS = ["files", "files[]", "file"] as const;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES_PER_UPLOAD, fields: 20, fieldSize: 16 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (ALLOWED_IMAGE_TYPES[file.mimetype.toLowerCase()]) return callback(null, true);
    callback(
      new HttpError(
        415,
        "unsupported_media_type",
        `"${file.originalname}" is not a supported image. Use JPEG, PNG, WebP, AVIF, GIF or SVG.`,
      ),
    );
  },
});

const parseMultipart = upload.fields(FILE_FIELDS.map((name) => ({ name, maxCount: MAX_FILES_PER_UPLOAD })));
const MAX_UPLOAD_LABEL = `${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`;

/** Multipart parsing with a user-facing message for oversized files (multer's own is "File too large"). */
const receiveFiles: RequestHandler = (req, res, next) => {
  parseMultipart(req, res, (error?: unknown) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      next(new HttpError(413, "payload_too_large", `Images can be at most ${MAX_UPLOAD_LABEL} each. Compress or resize the file and try again.`));
      return;
    }
    next(error);
  });
};

/**
 * Per-user ceiling for direct uploads (one signature + one registration per
 * file). Registration calls the Cloudinary Admin API, whose hourly quota is
 * shared by the whole account, so it gets the tighter limit.
 */
function directUploadLimiter(limit: number) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => (req.auth ? `user:${req.auth.userId.toString()}` : ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown")),
    handler: (_req, _res, next, options) => {
      next(new HttpError(options.statusCode, "rate_limited", "Too many uploads in a short time. Please wait a few minutes and try again."));
    },
  });
}

const signLimiter = directUploadLimiter(200);
const registerLimiter = directUploadLimiter(100);

function uploadedFiles(files: unknown): UploadFile[] {
  if (!files || typeof files !== "object") return [];
  const groups = Array.isArray(files) ? [files] : Object.values(files as Record<string, Express.Multer.File[]>);
  return groups.flat().map((file: Express.Multer.File) => ({
    originalname: file.originalname,
    mimetype: file.mimetype,
    buffer: file.buffer,
    size: file.size,
  }));
}

/**
 * /api/admin/media. Mounted behind `requireAuth` + `requireWriteAccess`, so
 * viewers can browse and only editors/admins can upload, edit or delete.
 */
export const mediaRouter = Router();

mediaRouter.get("/", async (req, res) => {
  res.json(await listMedia(parseQuery(mediaListQuery, req)));
});

mediaRouter.get("/folders", async (_req, res) => {
  res.json(await listFolders());
});

mediaRouter.post("/", receiveFiles, async (req, res) => {
  const fields = parseBody(uploadFieldsSchema, req);
  const files = uploadedFiles(req.files);
  const media = await uploadMedia(files, { folder: fields.folder || undefined, alt: fields.alt, tags: fields.tags }, req);
  res.status(201).json(media);
});

/** Signed parameters for one direct browser → Cloudinary upload (the multipart route above stays as the fallback). */
mediaRouter.post("/sign", signLimiter, (req, res) => {
  const { folder } = parseBody(signUploadSchema, req);
  res.json(createUploadSignature(folder || undefined));
});

/** Adds a direct upload to the library: 201 when created, 200 with the existing record when already registered. */
mediaRouter.post("/register", registerLimiter, async (req, res) => {
  const { media, created } = await registerMedia(parseBody(registerMediaSchema, req), req);
  res.status(created ? 201 : 200).json(media);
});

mediaRouter.get("/:id/usage", async (req, res) => {
  res.json(await getMediaUsage(requireObjectId(req.params.id, "Media")));
});

mediaRouter.get("/:id", async (req, res) => {
  res.json(await getMedia(requireObjectId(req.params.id, "Media")));
});

mediaRouter.patch("/:id", async (req, res) => {
  const input = parseBody(updateMediaSchema, req);
  res.json(await updateMedia(requireObjectId(req.params.id, "Media"), input, req));
});

mediaRouter.delete("/:id", async (req, res) => {
  const { force } = parseQuery(deleteMediaQuery, req);
  const { usage } = await deleteMedia(requireObjectId(req.params.id, "Media"), force, req);
  res.json({ ok: true, detachedFrom: usage.length });
});
