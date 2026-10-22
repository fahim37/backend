import { SettingsModel } from "../../models/settings.js";
import { UserModel } from "../../models/user.js";
import { COLLECTION_KEYS } from "../../types.js";
import { contentRegistry } from "../content/registry.js";

/** Where a media item is referenced. `paths` are dotted field paths, e.g. "seo.image". */
export type MediaUsage = { collection: string; id: string; label: string; paths: string[] };

export type MediaRef = { id: string; publicId: string; url: string };

const SETTINGS_LABELS: Record<string, string> = { site: "Site settings", home: "Homepage" };

/**
 * Walks any JSON-like value and returns the paths that reference the media:
 * an object whose `mediaId` or `publicId` matches, or a string equal to the
 * asset URL (e.g. a bare URL pasted into a link field).
 */
export function findReferences(value: unknown, ref: MediaRef, path = ""): string[] {
  if (typeof value === "string") return value === ref.url ? [path || "(root)"] : [];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findReferences(item, ref, path ? `${path}.${index}` : String(index)));
  }
  if (value instanceof Date) return [];

  const record = value as Record<string, unknown>;
  const mediaId = record.mediaId == null ? "" : String(record.mediaId);
  const matchesSelf =
    (mediaId !== "" && mediaId === ref.id) || (typeof record.publicId === "string" && record.publicId === ref.publicId);
  if (matchesSelf) return [path || "(root)"];

  return Object.entries(record).flatMap(([key, child]) => {
    if (key === "_id") return [];
    return findReferences(child, ref, path ? `${path}.${key}` : key);
  });
}

function labelOf(doc: Record<string, unknown>, field: string): string {
  const value = doc[field];
  return typeof value === "string" && value ? value : String(doc._id);
}

/** Every content document, settings singleton and user avatar that references the media. */
export async function scanMediaUsage(ref: MediaRef): Promise<MediaUsage[]> {
  const contentScans = COLLECTION_KEYS.map(async (key): Promise<MediaUsage[]> => {
    const config = contentRegistry[key];
    const docs = await config.model.find().lean<Record<string, unknown>[]>();
    return docs.flatMap((doc) => {
      const paths = findReferences(doc, ref);
      return paths.length ? [{ collection: key, id: String(doc._id), label: labelOf(doc, config.labelField), paths }] : [];
    });
  });

  const settingsScan = (async (): Promise<MediaUsage[]> => {
    const docs = await SettingsModel.find().select("key data").lean();
    return docs.flatMap((doc) => {
      const paths = findReferences(doc.data, ref);
      return paths.length ? [{ collection: "settings", id: doc.key, label: SETTINGS_LABELS[doc.key] ?? doc.key, paths }] : [];
    });
  })();

  const usersScan = (async (): Promise<MediaUsage[]> => {
    const docs = await UserModel.find({ avatar: { $ne: null } }).select("name avatar").lean();
    return docs.flatMap((doc) => {
      const paths = findReferences({ avatar: doc.avatar }, ref);
      return paths.length ? [{ collection: "users", id: String(doc._id), label: doc.name, paths }] : [];
    });
  })();

  const results = await Promise.all([...contentScans, settingsScan, usersScan]);
  return results.flat();
}
