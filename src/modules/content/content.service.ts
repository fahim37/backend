import type { Request } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { logActivity, type ActivityInput } from "../../lib/activity.js";
import { notifyContentChanged } from "../../lib/content-events.js";
import { notFound } from "../../lib/errors.js";
import { objectIdString } from "../../lib/object-id.js";
import { pageWindow, paginated, paginationQuery, parseSort } from "../../lib/pagination.js";
import { escapeRegex, slugify, uniqueSlug } from "../../lib/slug.js";
import type { ContentRecord } from "../../models/content.js";
import { resolveDefaults } from "../../schemas/content.js";
import { statusSchema } from "../../schemas/common.js";
import type { Paginated } from "../../types.js";
import type { CollectionConfig } from "./registry.js";

/** Fields clients may never write directly. */
const SYSTEM_FIELDS = ["_id", "createdAt", "updatedAt"] as const;

export const contentListQuery = paginationQuery.extend({
  q: z.string().trim().max(200).optional(),
  status: statusSchema.optional(),
  sort: z.string().trim().max(200).optional(),
});

export const reorderSchema = z.object({
  ids: z.array(objectIdString).min(1, "Provide at least one id").max(1000),
});

export const bulkSchema = z.object({
  action: z.enum(["publish", "draft", "delete"]),
  ids: z.array(objectIdString).min(1, "Select at least one item").max(1000),
});

export type ContentJson = Record<string, unknown> & { _id: string };

function labelOf(config: CollectionConfig, doc: Record<string, unknown>): string | undefined {
  const value = doc[config.labelField];
  return typeof value === "string" ? value : undefined;
}

function withoutSystemFields(body: unknown): Record<string, unknown> {
  const input = body && typeof body === "object" && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {};
  for (const field of SYSTEM_FIELDS) delete input[field];
  return input;
}

/** JSON-safe representation (ObjectIds → strings, Dates → ISO). */
function toJson(doc: unknown): ContentJson {
  return JSON.parse(JSON.stringify(doc)) as ContentJson;
}

async function record(req: Request, input: ActivityInput): Promise<void> {
  notifyContentChanged();
  await logActivity(req, input);
}

async function nextOrder(config: CollectionConfig): Promise<number> {
  const last = await config.model.findOne().sort({ order: -1 }).select("order").lean<{ order?: number }>();
  return typeof last?.order === "number" ? last.order + 1 : 0;
}

async function uniqueValue(config: CollectionConfig, base: string, excludeId?: Types.ObjectId): Promise<string> {
  const field = config.uniqueField;
  if (!field) return base;
  return uniqueSlug(base, async (candidate) => {
    const filter: Record<string, unknown> = { [field]: candidate };
    if (excludeId) filter._id = { $ne: excludeId };
    return (await config.model.exists(filter)) !== null;
  });
}

function parseFilters(config: CollectionConfig, query: Record<string, unknown>): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(config.filters)) {
    const raw = query[field];
    if (typeof raw !== "string" || raw === "") continue;
    if (kind === "boolean") {
      if (raw === "true" || raw === "false") filter[field] = raw === "true";
    } else if (field === "group" && raw === "none") {
      filter[field] = null;
    } else {
      filter[field] = raw.slice(0, 200);
    }
  }
  return filter;
}

export async function listContent(config: CollectionConfig, rawQuery: Record<string, unknown>): Promise<Paginated<ContentJson>> {
  const query = contentListQuery.parse(rawQuery);
  const filter: Record<string, unknown> = parseFilters(config, rawQuery);
  if (query.status) filter.status = query.status;
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), "i");
    filter.$or = config.searchFields.map((field) => ({ [field]: pattern }));
  }
  const sort = parseSort(query.sort, config.sortFields, { order: 1 });
  const { skip, limit } = pageWindow(query);
  const [items, total] = await Promise.all([
    config.model.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    config.model.countDocuments(filter),
  ]);
  return paginated(items.map(toJson), total, query);
}

export async function getContent(config: CollectionConfig, id: Types.ObjectId): Promise<ContentJson> {
  const doc = await config.model.findById(id).lean();
  if (!doc) throw notFound(`Item not found in ${config.key}`);
  return toJson(doc);
}

export async function createContent(config: CollectionConfig, body: unknown, req: Request): Promise<ContentJson> {
  const input: Record<string, unknown> = { ...resolveDefaults(config.key), ...withoutSystemFields(body) };

  const { uniqueField, slugSource } = config;
  if (uniqueField && slugSource) {
    const current = input[uniqueField];
    const source = input[slugSource];
    if ((current === undefined || current === null || current === "") && typeof source === "string" && source.trim()) {
      input[uniqueField] = await uniqueValue(config, slugify(source));
    }
  }
  if (input.order === undefined || input.order === null) input.order = await nextOrder(config);

  const data = config.createSchema.parse(input);
  const created = await config.model.create(data);
  const json = toJson(created.toJSON());
  await record(req, { action: "create", entity: config.key, entityId: json._id, label: labelOf(config, json) });
  return json;
}

export async function updateContent(
  config: CollectionConfig,
  id: Types.ObjectId,
  body: unknown,
  req: Request,
): Promise<ContentJson> {
  const data = config.updateSchema.parse(withoutSystemFields(body)) as Record<string, unknown>;
  const before = await config.model.findById(id).select("status").lean<{ status: string }>();
  if (!before) throw notFound(`Item not found in ${config.key}`);
  if (Object.keys(data).length === 0) return getContent(config, id);

  const updated = await config.model.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true }).lean();
  if (!updated) throw notFound(`Item not found in ${config.key}`);
  const json = toJson(updated);

  const statusChanged = typeof data.status === "string" && data.status !== before.status;
  const action = statusChanged ? (data.status === "published" ? "publish" : "unpublish") : "update";
  await record(req, { action, entity: config.key, entityId: json._id, label: labelOf(config, json) });
  return json;
}

export async function deleteContent(config: CollectionConfig, id: Types.ObjectId, req: Request): Promise<void> {
  const deleted = await config.model.findByIdAndDelete(id).lean();
  if (!deleted) throw notFound(`Item not found in ${config.key}`);
  await record(req, { action: "delete", entity: config.key, entityId: String(id), label: labelOf(config, deleted) });
}

export async function duplicateContent(config: CollectionConfig, id: Types.ObjectId, req: Request): Promise<ContentJson> {
  const source = await config.model.findById(id).lean<ContentRecord>();
  if (!source) throw notFound(`Item not found in ${config.key}`);

  const { _id, createdAt, updatedAt, ...copy } = source;
  void _id;
  void createdAt;
  void updatedAt;
  copy.status = "draft";
  copy.order = await nextOrder(config);

  const { uniqueField, labelField } = config;
  if (uniqueField && typeof source[uniqueField] === "string") {
    copy[uniqueField] = await uniqueValue(config, `${source[uniqueField] as string}-copy`);
  }
  if (labelField !== uniqueField && typeof source[labelField] === "string") {
    copy[labelField] = `${source[labelField] as string} (copy)`;
  }

  const created = await config.model.create(copy);
  const json = toJson(created.toJSON());
  await record(req, { action: "create", entity: config.key, entityId: json._id, label: labelOf(config, json) });
  return json;
}

export async function reorderContent(config: CollectionConfig, ids: string[], req: Request): Promise<{ updated: number }> {
  const unique = [...new Set(ids)];
  const result = await config.model.bulkWrite(
    unique.map((id, index) => ({ updateOne: { filter: { _id: id }, update: { $set: { order: index } } } })),
    { ordered: false },
  );
  await record(req, { action: "reorder", entity: config.key, label: `${unique.length} items` });
  return { updated: result.modifiedCount };
}

export async function bulkContent(
  config: CollectionConfig,
  action: z.output<typeof bulkSchema>["action"],
  ids: string[],
  req: Request,
): Promise<{ count: number }> {
  const filter = { _id: { $in: [...new Set(ids)] } };
  let count: number;
  if (action === "delete") {
    count = (await config.model.deleteMany(filter)).deletedCount;
  } else {
    const status = action === "publish" ? "published" : "draft";
    count = (await config.model.updateMany(filter, { $set: { status } })).modifiedCount;
  }
  const activityAction = action === "delete" ? "delete" : action === "publish" ? "publish" : "unpublish";
  await record(req, { action: activityAction, entity: config.key, label: `${count} item${count === 1 ? "" : "s"}` });
  return { count };
}
