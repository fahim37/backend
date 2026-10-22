import { v2 as cloudinary, type UploadApiOptions, type UploadApiResponse } from "cloudinary";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

/** Width of the tiny preview encoded into `blurDataURL`. */
const BLUR_WIDTH = 16;
const BLUR_TIMEOUT_MS = 5000;
const BLUR_MAX_BYTES = 8 * 1024;

let configured = false;

export function isCloudinaryConfigured(): boolean {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

/** The configured SDK; throws 503 when credentials are missing. */
export function getCloudinary(): typeof cloudinary {
  if (!isCloudinaryConfigured()) {
    throw new HttpError(503, "media_unavailable", "Media uploads are not configured on the server (Cloudinary credentials missing)");
  }
  if (!configured) {
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    configured = true;
  }
  return cloudinary;
}

/** Full Cloudinary folder for a logical media folder, e.g. "library" → "srsit/library". */
export function cloudinaryFolder(folder: string): string {
  return [env.CLOUDINARY_FOLDER, folder].filter(Boolean).join("/");
}

/**
 * Segments of a Cloudinary path (public id or asset folder) below
 * CLOUDINARY_FOLDER, e.g. "srsit/team/jane_x1y2z3" → ["team", "jane_x1y2z3"];
 * null when the path is outside that folder or has empty/dot segments.
 */
export function pathBelowMediaRoot(value: string): string[] | null {
  const root = cloudinaryFolder("").split("/").filter(Boolean);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  if (segments.length < root.length || root.some((segment, index) => segments[index] !== segment)) return null;
  return segments.slice(root.length);
}

/** Upload API endpoint that browsers post signed direct uploads to. */
export function imageUploadUrl(): string {
  return `https://api.cloudinary.com/v1_1/${encodeURIComponent(env.CLOUDINARY_CLOUD_NAME ?? "")}/image/upload`;
}

/**
 * Signs a fixed, server-chosen set of upload parameters for a direct browser
 * upload. Never pass client-provided parameters through unchecked: whatever is
 * signed here is what Cloudinary will accept.
 */
export function signUploadParams(params: Record<string, string>): { signature: string; apiKey: string; cloudName: string } {
  const sdk = getCloudinary();
  return {
    signature: sdk.utils.api_sign_request(params, env.CLOUDINARY_API_SECRET ?? ""),
    apiKey: env.CLOUDINARY_API_KEY ?? "",
    cloudName: env.CLOUDINARY_CLOUD_NAME ?? "",
  };
}

/** The Admin API fields the library relies on (`api.resource`). */
export type CloudinaryResource = {
  public_id: string;
  secure_url: string;
  format?: string;
  resource_type?: string;
  type?: string;
  width?: number;
  height?: number;
  bytes?: number;
  created_at?: string;
  /** Dynamic folder mode only. */
  asset_folder?: string;
};

type CloudinaryErrorShape = { message?: string; http_code?: number; error?: { message?: string; http_code?: number } };

function describeCloudinaryError(error: unknown): { message: string; httpCode?: number } {
  if (error && typeof error === "object") {
    const shape = error as CloudinaryErrorShape;
    const message = shape.message ?? shape.error?.message;
    const httpCode = shape.http_code ?? shape.error?.http_code;
    if (message) return { message, httpCode };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

/** Maps a Cloudinary SDK error to an API error: rejected images → 422, rate limits → 429, anything else → 502. */
export function toCloudinaryHttpError(error: unknown, fallback = "The media service could not complete the request"): HttpError {
  if (error instanceof HttpError) return error;
  const { message, httpCode } = describeCloudinaryError(error);
  if (httpCode === 400) return new HttpError(422, "invalid_image", message || "The file is not a valid image");
  if (httpCode === 420 || httpCode === 429) {
    return new HttpError(429, "rate_limited", "The media service is busy right now. Please try again in a few minutes.", { reason: message });
  }
  return new HttpError(502, "media_service_error", fallback, { reason: message });
}

/**
 * Admin API details of an uploaded image (`type: upload`), or null when
 * Cloudinary has no such image. Counts against the Admin API hourly limit.
 */
export async function findImageResource(publicId: string): Promise<CloudinaryResource | null> {
  const sdk = getCloudinary();
  try {
    return (await sdk.api.resource(publicId, { resource_type: "image", type: "upload" })) as CloudinaryResource;
  } catch (error) {
    if (describeCloudinaryError(error).httpCode === 404) return null;
    throw toCloudinaryHttpError(error, "Cloudinary could not look up the uploaded image");
  }
}

/** Streams a buffer to Cloudinary. */
export function uploadBuffer(buffer: Buffer, options: UploadApiOptions): Promise<UploadApiResponse> {
  const sdk = getCloudinary();
  return new Promise((resolve, reject) => {
    const stream = sdk.uploader.upload_stream({ resource_type: "image", ...options }, (error, result) => {
      if (error || !result) reject(error ?? new Error("Cloudinary returned an empty response"));
      else resolve(result);
    });
    stream.end(buffer);
  });
}

/**
 * Removes an asset and purges CDN copies. A missing asset counts as success,
 * so deletes stay idempotent.
 */
export async function destroyAsset(publicId: string, resourceType: "image" | "video" | "raw" = "image"): Promise<void> {
  const sdk = getCloudinary();
  const result = (await sdk.uploader.destroy(publicId, { invalidate: true, resource_type: resourceType })) as { result?: string };
  if (result.result !== "ok" && result.result !== "not found") {
    throw new HttpError(502, "media_service_error", "Cloudinary could not delete the file", { result: result.result });
  }
}

/** Delivery URL of a transformed variant (no SDK analytics query string). */
export function transformedUrl(publicId: string, transformation: string): string {
  const cloud = env.CLOUDINARY_CLOUD_NAME ?? "";
  const path = publicId.split("/").map(encodeURIComponent).join("/");
  return `https://res.cloudinary.com/${cloud}/image/upload/${transformation}/${path}`;
}

/**
 * A ~16px wide preview of the asset as a base64 data URL, for `placeholder="blur"`.
 * Returns undefined on any failure: a missing placeholder never fails an upload.
 */
export async function createBlurDataUrl(publicId: string): Promise<string | undefined> {
  if (!isCloudinaryConfigured()) return undefined;
  const url = transformedUrl(publicId, `c_limit,w_${BLUR_WIDTH}/f_auto,q_30`);
  try {
    const response = await fetch(url, {
      headers: { accept: "image/webp,image/png,image/*;q=0.8" },
      signal: AbortSignal.timeout(BLUR_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = (response.headers.get("content-type") ?? "image/jpeg").split(";")[0]?.trim() || "image/jpeg";
    if (!type.startsWith("image/")) throw new Error(`unexpected content type ${type}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > BLUR_MAX_BYTES) throw new Error(`unexpected preview size ${bytes.length}`);
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch (error) {
    logger.warn({ publicId, err: error instanceof Error ? error.message : String(error) }, "could not create blur placeholder");
    return undefined;
  }
}
