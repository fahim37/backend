import type { Types } from "mongoose";
import { z } from "zod";
import { isObjectIdString } from "../../lib/object-id.js";
import { pageWindow, paginated, paginationQuery } from "../../lib/pagination.js";
import { escapeRegex } from "../../lib/slug.js";
import { ACTIVITY_ACTIONS, ActivityModel, type ActivityRecord } from "../../models/activity.js";
import type { Activity, Paginated } from "../../types.js";

export const activityListQuery = paginationQuery.extend({
  entity: z.string().trim().max(100).optional(),
  action: z.enum(ACTIVITY_ACTIONS).optional(),
  user: z.string().trim().optional(),
});

type PopulatedActivity = Omit<ActivityRecord, "user"> & {
  user?: { _id: Types.ObjectId; name: string; email: string } | null;
};

function toActivity(doc: PopulatedActivity): Activity {
  return {
    _id: String(doc._id),
    user: doc.user ? { _id: String(doc.user._id), name: doc.user.name, email: doc.user.email } : null,
    action: doc.action,
    entity: doc.entity,
    entityId: doc.entityId,
    label: doc.label,
    createdAt: doc.createdAt.toISOString(),
  };
}

export async function listActivity(query: z.output<typeof activityListQuery>): Promise<Paginated<Activity>> {
  const filter: Record<string, unknown> = {};
  // "settings" matches "settings:site" and "settings:home".
  if (query.entity) filter.entity = new RegExp(`^${escapeRegex(query.entity)}(?::|$)`);
  if (query.action) filter.action = query.action;
  if (query.user && isObjectIdString(query.user)) filter.user = query.user;
  const { skip, limit } = pageWindow(query);
  const [items, total] = await Promise.all([
    ActivityModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "name email")
      .lean<PopulatedActivity[]>(),
    ActivityModel.countDocuments(filter),
  ]);
  return paginated(items.map(toActivity), total, query);
}

export async function recentActivity(limit = 10): Promise<Activity[]> {
  const items = await ActivityModel.find()
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .populate("user", "name email")
    .lean<PopulatedActivity[]>();
  return items.map(toActivity);
}
