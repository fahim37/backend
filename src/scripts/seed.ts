/**
 * Seeds the CMS from the site's bundled content (lib/cms/fallback.ts), so a
 * fresh database renders exactly what the site shows today.
 *
 *   npm run seed                  # insert missing documents and settings only (never touches admin edits)
 *   npm run seed -- --force       # also overwrite the seeded fields of existing documents and settings
 *   npm run seed -- --reset       # delete every content document first, then seed (users and media are kept)
 *   npm run seed -- --no-upload   # keep local /assets image URLs instead of uploading to Cloudinary
 *
 * Images referenced as "/assets/<file>" are uploaded once to Cloudinary under
 * `${CLOUDINARY_FOLDER}/site/<file name without extension>` (re-runs reuse the
 * existing assets), recorded in the media library, and the content's image
 * references are rewritten to the Cloudinary URLs. The env admin
 * (ADMIN_EMAIL / ADMIN_PASSWORD) is created when missing.
 *
 * Works against Atlas and against MONGODB_URI=memory (a throwaway database;
 * useful as a dry run that still performs the real Cloudinary uploads).
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { env } from "../config/env.js";
import { connectDb, disconnectDb } from "../db.js";
import { logActivity } from "../lib/activity.js";
import { upsertAdminFromEnv } from "../lib/bootstrap.js";
import { revalidateSite } from "../lib/revalidate.js";
import { contentModels } from "../models/content.js";
import { MediaModel, type MediaRecord } from "../models/media.js";
import { SettingsModel } from "../models/settings.js";
import { UserModel } from "../models/user.js";
import { contentRegistry } from "../modules/content/registry.js";
import {
  cloudinaryFolder,
  createBlurDataUrl,
  isCloudinaryConfigured,
  uploadBuffer,
} from "../modules/media/cloudinary.js";
import { mapWithConcurrency } from "../modules/media/concurrency.js";
import { titleFromFilename } from "../modules/media/media.service.js";
import { createSchemas, resolveDefaults } from "../schemas/content.js";
import { settingsSchemas, SETTINGS_KEYS } from "../schemas/settings.js";
import { COLLECTION_KEYS, type CmsImage, type CollectionKey, type PublicBundle } from "../types.js";

const ASSET_PREFIX = "/assets/";
const MEDIA_FOLDER = "site";
const SEED_TAG = "srsit-seed";
const UPLOAD_CONCURRENCY = 4;
const SYSTEM_FIELDS = new Set(["_id", "createdAt", "updatedAt"]);

type Mode = "insert" | "force" | "reset";
type Options = { mode: Mode; upload: boolean };

type Row = { name: string; seeded: number; created: number; updated: number; skipped: number; deleted: number };
type AssetOutcome = "uploaded" | "reused" | "library" | "missing" | "failed";
type AssetResult = { outcome: AssetOutcome; image?: Pick<CmsImage, "url" | "publicId" | "mediaId" | "width" | "height"> };

const USAGE = "Usage: npm run seed -- [--force | --reset] [--no-upload]";

function parseArgs(argv: string[]): Options {
  const known = new Set(["--force", "--reset", "--no-upload", "--help", "-h"]);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  if (unknown.length) throw new Error(`Unknown option ${unknown.join(", ")}\n${USAGE}`);
  const mode: Mode = argv.includes("--reset") ? "reset" : argv.includes("--force") ? "force" : "insert";
  return { mode, upload: !argv.includes("--no-upload") };
}

// ── Source content ───────────────────────────────────────────────────────────

/** The website repo (source of the bundled content and images); a sibling folder by default. */
const repoRoot = path.resolve(env.serverRoot, process.env.SITE_DIR ?? "../srsit");
const assetsRoot = path.join(repoRoot, "public", "assets");

function isBundle(value: unknown): value is PublicBundle {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return COLLECTION_KEYS.every((key) => Array.isArray(record[key])) && typeof record.site === "object" && typeof record.home === "object";
}

/**
 * Loads `fallbackBundle` from the site. The path is computed at runtime so the
 * API's TypeScript program does not pull in the Next.js sources.
 */
async function loadFallbackBundle(): Promise<PublicBundle> {
  const file = path.join(repoRoot, "lib", "cms", "fallback.ts");
  await stat(file).catch(() => {
    throw new Error(`Seed source not found: ${file}`);
  });
  const importedModule = (await import(pathToFileURL(file).href)) as { fallbackBundle?: unknown; default?: { fallbackBundle?: unknown } };
  const bundle = importedModule.fallbackBundle ?? importedModule.default?.fallbackBundle;
  if (!isBundle(bundle)) throw new Error("lib/cms/fallback.ts does not export a valid `fallbackBundle`");
  return structuredClone(bundle);
}

// ── Image walking ────────────────────────────────────────────────────────────

function isLocalAssetImage(value: unknown): value is CmsImage {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) && typeof (value as { url?: unknown }).url === "string" &&
      (value as { url: string }).url.startsWith(ASSET_PREFIX),
  );
}

/** Every local asset URL in the bundle, with the first non-empty alt text used for it. */
function collectAssets(value: unknown, found = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value)) {
    for (const item of value) collectAssets(item, found);
  } else if (value && typeof value === "object") {
    if (isLocalAssetImage(value)) {
      const alt = value.alt?.trim() ?? "";
      if (!found.has(value.url) || (!found.get(value.url) && alt)) found.set(value.url, alt);
    }
    for (const child of Object.values(value)) collectAssets(child, found);
  }
  return found;
}

/** Returns a copy of `value` with every uploaded local image pointing at Cloudinary. */
function rewriteImages<T>(value: T, assets: Map<string, AssetResult>): T {
  if (Array.isArray(value)) return value.map((item) => rewriteImages(item, assets)) as T;
  if (!value || typeof value !== "object") return value;
  const copy = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewriteImages(child, assets)]));
  if (isLocalAssetImage(value)) {
    const replacement = assets.get(value.url)?.image;
    if (replacement) return { ...copy, ...replacement } as T;
  }
  return copy as T;
}

// ── Cloudinary + media library ───────────────────────────────────────────────

function assetFile(url: string): { file: string; relative: string } | null {
  const relative = decodeURIComponent(url.slice(ASSET_PREFIX.length).split(/[?#]/)[0] ?? "");
  const file = path.resolve(assetsRoot, relative);
  if (!relative || !file.startsWith(assetsRoot + path.sep)) return null;
  return { file, relative: relative.split(path.sep).join("/") };
}

/** Deterministic public id, e.g. "srsit/site/AWS" for /assets/AWS.webp. */
function seedPublicId(relative: string): string {
  const withoutExtension = relative.replace(/\.[^./]+$/, "");
  const safe = withoutExtension.replace(/[^\w\-/]+/g, "-");
  return `${cloudinaryFolder(MEDIA_FOLDER)}/${safe}`;
}

function toImageRef(media: Pick<MediaRecord, "_id" | "url" | "publicId" | "width" | "height">): AssetResult["image"] {
  return {
    url: media.url,
    publicId: media.publicId,
    mediaId: media._id.toString(),
    ...(media.width > 0 ? { width: media.width } : {}),
    ...(media.height > 0 ? { height: media.height } : {}),
  };
}

async function syncAsset(url: string, alt: string, uploadedBy: MediaRecord["uploadedBy"]): Promise<AssetResult> {
  const location = assetFile(url);
  if (!location) return { outcome: "missing" };
  const publicId = seedPublicId(location.relative);

  const existing = await MediaModel.findOne({ publicId }).lean<MediaRecord>();
  if (existing) return { outcome: "library", image: toImageRef(existing) };

  const buffer = await readFile(location.file).catch(() => null);
  if (!buffer) return { outcome: "missing" };

  // overwrite:false makes re-runs idempotent: Cloudinary answers with the
  // stored asset (existing: true) instead of replacing it.
  const result = await uploadBuffer(buffer, {
    public_id: publicId,
    asset_folder: cloudinaryFolder(MEDIA_FOLDER),
    overwrite: false,
    tags: [SEED_TAG],
  });
  const blurDataURL = await createBlurDataUrl(result.public_id);
  const filename = path.posix.basename(location.relative);
  const media = await MediaModel.findOneAndUpdate(
    { publicId: result.public_id },
    {
      $setOnInsert: {
        publicId: result.public_id,
        url: result.secure_url,
        format: (result.format ?? path.extname(filename).slice(1)).toLowerCase(),
        resourceType: "image",
        width: result.width ?? 0,
        height: result.height ?? 0,
        bytes: result.bytes ?? buffer.length,
        folder: MEDIA_FOLDER,
        alt,
        title: titleFromFilename(filename),
        tags: [SEED_TAG],
        blurDataURL,
        uploadedBy,
      },
    },
    { upsert: true, new: true },
  ).lean<MediaRecord>();
  if (!media) throw new Error(`Could not record media ${result.public_id}`);
  return { outcome: (result as { existing?: boolean }).existing ? "reused" : "uploaded", image: toImageRef(media) };
}

// ── Content + settings ───────────────────────────────────────────────────────

/** Field that identifies a seeded document across runs. */
function identityField(key: CollectionKey): string {
  const config = contentRegistry[key];
  return config.uniqueField ?? config.labelField;
}

function stripSystemFields(doc: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([field]) => !SYSTEM_FIELDS.has(field)));
}

async function seedCollection(
  key: CollectionKey,
  items: Record<string, unknown>[],
  mode: Mode,
  errors: string[],
): Promise<Row> {
  const model = contentModels[key];
  const field = identityField(key);
  const row: Row = { name: key, seeded: items.length, created: 0, updated: 0, skipped: 0, deleted: 0 };

  if (mode === "reset") row.deleted = (await model.deleteMany({})).deletedCount;

  const prepared = new Map<string, Record<string, unknown>>();
  items.forEach((item, index) => {
    const source = stripSystemFields(item);
    const result = createSchemas[key].safeParse({ ...resolveDefaults(key), order: index, ...source });
    if (!result.success) {
      const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      errors.push(`${key}[${index}] ${String(source[field] ?? "")}: ${issues.join("; ")}`);
      return;
    }
    const data = result.data as Record<string, unknown>;
    const identity = String(data[field] ?? "");
    if (prepared.has(identity)) {
      errors.push(`${key}: duplicate ${field} "${identity}" in the seed source; kept the first`);
      return;
    }
    prepared.set(identity, data);
  });

  const identities = [...prepared.keys()];
  const existing = new Set(
    (await model.find({ [field]: { $in: identities } }).select(field).lean<Record<string, unknown>[]>()).map((doc) =>
      String(doc[field]),
    ),
  );

  const missing = identities.filter((identity) => !existing.has(identity)).map((identity) => prepared.get(identity)!);
  if (missing.length) row.created = (await model.insertMany(missing, { ordered: false })).length;

  const present = identities.filter((identity) => existing.has(identity));
  if (mode === "force" && present.length) {
    const result = await model.bulkWrite(
      present.map((identity) => ({
        updateOne: { filter: { [field]: identity }, update: { $set: prepared.get(identity)! } },
      })),
      { ordered: false },
    );
    row.updated = result.modifiedCount;
    row.skipped = present.length - result.modifiedCount;
  } else {
    row.skipped = present.length;
  }
  return row;
}

async function seedSettings(bundle: PublicBundle, mode: Mode, updatedBy: MediaRecord["uploadedBy"], errors: string[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const key of SETTINGS_KEYS) {
    const row: Row = { name: `settings:${key}`, seeded: 1, created: 0, updated: 0, skipped: 0, deleted: 0 };
    rows.push(row);
    const parsed = settingsSchemas[key].safeParse(bundle[key]);
    if (!parsed.success) {
      errors.push(`settings:${key}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
      continue;
    }
    const exists = (await SettingsModel.exists({ key })) !== null;
    if (exists && mode === "insert") {
      row.skipped = 1;
      continue;
    }
    await SettingsModel.findOneAndUpdate({ key }, { $set: { data: parsed.data, updatedBy } }, { upsert: true });
    if (exists) row.updated = 1;
    else row.created = 1;
  }
  return rows;
}

// ── Output ───────────────────────────────────────────────────────────────────

function printTable(headers: string[], rows: (string | number)[][]): void {
  const cells = [headers, ...rows].map((row) => row.map(String));
  const widths = headers.map((_, column) => Math.max(...cells.map((row) => row[column]?.length ?? 0)));
  const line = (row: string[]) =>
    row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join("  ");
  console.log(line(cells[0]!));
  console.log(widths.map((width) => "─".repeat(width)).join("  "));
  for (const row of cells.slice(1)) console.log(line(row));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const bundle = await loadFallbackBundle();
  const startedAt = Date.now();

  await connectDb();
  try {
    const target = env.isMemoryDb ? "in-memory MongoDB (dry run: data is discarded on exit)" : `MongoDB database "${env.MONGODB_DB}"`;
    console.log(`\nSeeding ${target} — mode: ${options.mode}${options.upload ? "" : ", no uploads"}\n`);

    let adminResult = "skipped (ADMIN_EMAIL / ADMIN_PASSWORD not set)";
    if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) adminResult = await upsertAdminFromEnv();
    const admin = env.ADMIN_EMAIL
      ? await UserModel.findOne({ email: env.ADMIN_EMAIL.toLowerCase() }).select("_id").lean()
      : await UserModel.findOne({ role: "admin" }).select("_id").lean();
    const actorId = admin?._id ?? null;

    // 1. Images → Cloudinary + media library.
    const assets = collectAssets(bundle);
    const assetResults = new Map<string, AssetResult>();
    const failures: string[] = [];
    if (!options.upload) {
      console.log(`Skipping uploads (--no-upload): ${assets.size} images keep their local /assets URLs.`);
    } else if (!isCloudinaryConfigured()) {
      console.log(`Cloudinary is not configured: ${assets.size} images keep their local /assets URLs.`);
    } else {
      console.log(`Syncing ${assets.size} images to Cloudinary folder "${cloudinaryFolder(MEDIA_FOLDER)}"…`);
      await mapWithConcurrency([...assets], UPLOAD_CONCURRENCY, async ([url, alt]) => {
        try {
          const result = await syncAsset(url, alt, actorId);
          assetResults.set(url, result);
          if (result.outcome === "missing") failures.push(`${url}: file not found under public/assets`);
        } catch (error) {
          assetResults.set(url, { outcome: "failed" });
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          failures.push(`${url}: ${message}`);
        }
      });
    }
    const assetCount = (outcome: AssetOutcome) => [...assetResults.values()].filter((result) => result.outcome === outcome).length;
    const uploaded = assetCount("uploaded");
    if (uploaded > 0) {
      await logActivity(actorId, { action: "upload", entity: "media", label: `${uploaded} site image${uploaded === 1 ? "" : "s"} (seed)` });
    }

    // 2. Content + settings, with image references pointing at Cloudinary.
    const content = rewriteImages(bundle, assetResults);
    const errors: string[] = [];
    const rows: Row[] = [];
    for (const key of COLLECTION_KEYS) {
      rows.push(await seedCollection(key, content[key] as unknown as Record<string, unknown>[], options.mode, errors));
    }
    rows.push(...(await seedSettings(content, options.mode, actorId, errors)));

    const created = rows.reduce((sum, row) => sum + row.created, 0);
    const updated = rows.reduce((sum, row) => sum + row.updated, 0);
    const deleted = rows.reduce((sum, row) => sum + row.deleted, 0);
    if (created + updated + deleted > 0) {
      await logActivity(actorId, {
        action: options.mode === "insert" ? "create" : "update",
        entity: "seed",
        label: `Seeded site content (${created} created, ${updated} updated${deleted ? `, ${deleted} removed first` : ""})`,
      });
    }

    // 3. Report.
    console.log("");
    printTable(
      ["Collection", "In source", "Created", "Updated", "Unchanged", "Deleted"],
      [
        ...rows.map((row) => [row.name, row.seeded, row.created, row.updated, row.skipped, row.deleted]),
        ["total", rows.reduce((s, r) => s + r.seeded, 0), created, updated, rows.reduce((s, r) => s + r.skipped, 0), deleted],
      ],
    );
    console.log("");
    printTable(
      ["Images", "Count"],
      [
        ["referenced", assets.size],
        ["uploaded to Cloudinary now", uploaded],
        ["already on Cloudinary (reused)", assetCount("reused")],
        ["already in the media library", assetCount("library")],
        ["missing / failed", assetCount("missing") + assetCount("failed")],
        ["media library total", await MediaModel.countDocuments()],
      ],
    );
    console.log(`\nAdmin user: ${adminResult}`);

    if (!env.isMemoryDb && created + updated + deleted + uploaded > 0) {
      const result = await revalidateSite(["cms"]);
      console.log(
        `Site revalidation: ${result.skipped ? "skipped (SITE_URL not set)" : result.ok ? "ok" : `failed (${result.error ?? result.status})`}`,
      );
    }

    for (const failure of failures) console.error(`  image: ${failure}`);
    for (const error of errors) console.error(`  invalid: ${error}`);
    console.log(`\nDone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s${failures.length + errors.length ? " with problems (see above)" : ""}.`);
    return failures.length + errors.length > 0 ? 1 : 0;
  } finally {
    await disconnectDb();
  }
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`Seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
