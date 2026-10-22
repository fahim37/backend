import { createHash } from "node:crypto";
import { getCachedBundle, type CachedBundle } from "../../lib/public-cache.js";
import { ActivityModel } from "../../models/activity.js";
import { SettingsModel } from "../../models/settings.js";
import { emptySettings } from "../../schemas/settings.js";
import { COLLECTION_KEYS, type CollectionKey, type PublicBundle, type SettingsKey } from "../../types.js";
import { contentRegistry } from "../content/registry.js";

type Dated = { updatedAt?: Date | string; createdAt?: Date | string };

function latest(current: number, doc: Dated | null | undefined): number {
  const value = doc?.updatedAt ?? doc?.createdAt;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) && time > current ? time : current;
}

async function buildBundle(): Promise<CachedBundle> {
  const [collections, settings, lastChange] = await Promise.all([
    Promise.all(
      COLLECTION_KEYS.map(async (key) => {
        const docs = await contentRegistry[key].model.find({ status: "published" }).sort({ order: 1, _id: 1 }).lean();
        return [key, docs] as const;
      }),
    ),
    SettingsModel.find({ key: { $in: ["site", "home"] } }).lean(),
    // Deletions and unpublishing leave no published document behind, so the
    // newest admin activity also moves the version forward.
    ActivityModel.findOne({ entity: { $in: [...COLLECTION_KEYS, "settings:site", "settings:home", "media"] } })
      .sort({ createdAt: -1 })
      .select("createdAt")
      .lean(),
  ]);

  let versionTime = latest(0, lastChange);
  const bundle: Record<string, unknown> = {};
  for (const [key, docs] of collections) {
    for (const doc of docs) versionTime = latest(versionTime, doc as Dated);
    bundle[key] = docs;
  }
  for (const key of ["site", "home"] as const) {
    const stored = settings.find((entry) => entry.key === key);
    versionTime = latest(versionTime, stored);
    bundle[key] = stored?.data ?? emptySettings[key];
  }
  const version = new Date(versionTime || Date.now()).toISOString();
  bundle.version = version;

  const body = JSON.stringify(bundle);
  const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
  return { body, data: JSON.parse(body) as Record<string, unknown>, etag, version, builtAt: Date.now() };
}

/** The cached `PublicBundle` (published content + settings). */
export function getPublicBundle(): Promise<CachedBundle> {
  return getCachedBundle(buildBundle);
}

export async function getPublicCollection(key: CollectionKey): Promise<{ items: unknown[]; etag: string }> {
  const bundle = await getPublicBundle();
  return { items: (bundle.data[key] as unknown[]) ?? [], etag: derivedEtag(bundle.etag, key) };
}

/** Finds a published item by its slug/key/from, or by `_id` for collections without one. */
export async function getPublicItem(key: CollectionKey, identifier: string): Promise<{ item: unknown; etag: string } | null> {
  const { items } = await getPublicCollection(key);
  const field = contentRegistry[key].uniqueField;
  const wanted = field === "from" && !identifier.startsWith("/") ? `/${identifier}` : identifier;
  const item = (items as Record<string, unknown>[]).find((entry) =>
    field ? entry[field] === wanted || entry._id === identifier : entry._id === identifier,
  );
  if (!item) return null;
  const bundle = await getPublicBundle();
  return { item, etag: derivedEtag(bundle.etag, `${key}:${identifier}`) };
}

export async function getPublicSettings<K extends SettingsKey>(key: K): Promise<{ data: PublicBundle[K]; etag: string }> {
  const bundle = await getPublicBundle();
  return { data: bundle.data[key] as PublicBundle[K], etag: derivedEtag(bundle.etag, `settings:${key}`) };
}

function derivedEtag(bundleEtag: string, suffix: string): string {
  const hash = createHash("sha1").update(`${bundleEtag}|${suffix}`).digest("base64url");
  return `"${hash}"`;
}
