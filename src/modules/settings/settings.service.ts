import type { Request } from "express";
import { logActivity } from "../../lib/activity.js";
import { notifyContentChanged } from "../../lib/content-events.js";
import { SettingsModel } from "../../models/settings.js";
import { emptySettings, SETTINGS_KEYS, settingsSchemas } from "../../schemas/settings.js";
import type { SettingsKey, SettingsMap } from "../../types.js";

export function isSettingsKey(value: unknown): value is SettingsKey {
  return typeof value === "string" && (SETTINGS_KEYS as readonly string[]).includes(value);
}

/** Stored settings, or structurally valid empty defaults when nothing was saved yet. */
export async function getSettings<K extends SettingsKey>(key: K): Promise<SettingsMap[K]> {
  const stored = await SettingsModel.findOne({ key }).select("data").lean();
  return (stored?.data as SettingsMap[K] | undefined) ?? structuredClone(emptySettings[key]);
}

/** Validates and replaces a settings document. Pass `req` to record activity. */
export async function saveSettings<K extends SettingsKey>(key: K, input: unknown, req?: Request): Promise<SettingsMap[K]> {
  const data = settingsSchemas[key].parse(input) as SettingsMap[K];
  await SettingsModel.findOneAndUpdate(
    { key },
    { $set: { data, updatedBy: req?.auth?.userId ?? null } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  notifyContentChanged();
  if (req) await logActivity(req, { action: "settings", entity: `settings:${key}`, label: key === "site" ? "Site settings" : "Homepage" });
  return data;
}
