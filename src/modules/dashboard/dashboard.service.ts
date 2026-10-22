import { contentModels } from "../../models/content.js";
import { EnquiryModel } from "../../models/enquiry.js";
import { MediaModel } from "../../models/media.js";
import { UserModel } from "../../models/user.js";
import {
  COLLECTION_KEYS,
  ENQUIRY_STATUSES,
  type DashboardStats,
  type Enquiry,
  type EnquiryStatus,
} from "../../types.js";
import { recentActivity } from "../activity/activity.service.js";

const DAILY_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Enquiries per UTC day for the last 30 days (today included), zero-filled. */
async function dailyEnquiries(now = new Date()): Promise<{ date: string; count: number }[]> {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = new Date(todayStart - (DAILY_WINDOW_DAYS - 1) * DAY_MS);
  const rows = await EnquiryModel.aggregate<{ _id: string; count: number }>([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } }, count: { $sum: 1 } } },
  ]);
  const counts = new Map(rows.map((row) => [row._id, row.count]));
  return Array.from({ length: DAILY_WINDOW_DAYS }, (_, index) => {
    const date = utcDay(new Date(since.getTime() + index * DAY_MS));
    return { date, count: counts.get(date) ?? 0 };
  });
}

async function enquiriesByStatus(): Promise<Record<EnquiryStatus, number>> {
  const rows = await EnquiryModel.aggregate<{ _id: EnquiryStatus; count: number }>([
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const result = Object.fromEntries(ENQUIRY_STATUSES.map((status) => [status, 0])) as Record<EnquiryStatus, number>;
  for (const row of rows) if (row._id in result) result[row._id] = row.count;
  return result;
}

async function mediaTotals(): Promise<{ count: number; bytes: number }> {
  const [row] = await MediaModel.aggregate<{ count: number; bytes: number }>([
    { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: "$bytes" } } },
  ]);
  return { count: row?.count ?? 0, bytes: row?.bytes ?? 0 };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const collectionCounts = Promise.all(
    COLLECTION_KEYS.map(async (key) => {
      const model = contentModels[key];
      const [total, drafts] = await Promise.all([model.countDocuments(), model.countDocuments({ status: "draft" })]);
      return { key, total, drafts };
    }),
  );

  const [perCollection, enquiryTotal, userTotal, byStatus, daily, recent, media, activity] = await Promise.all([
    collectionCounts,
    EnquiryModel.countDocuments(),
    UserModel.countDocuments(),
    enquiriesByStatus(),
    dailyEnquiries(),
    EnquiryModel.find().sort({ createdAt: -1 }).limit(5).lean(),
    mediaTotals(),
    recentActivity(10),
  ]);

  const counts = Object.fromEntries(perCollection.map(({ key, total }) => [key, total])) as DashboardStats["counts"];
  counts.media = media.count;
  counts.enquiries = enquiryTotal;
  counts.users = userTotal;

  return {
    counts,
    drafts: perCollection.reduce((sum, { drafts }) => sum + drafts, 0),
    enquiries: {
      byStatus,
      daily,
      recent: JSON.parse(JSON.stringify(recent)) as Enquiry[],
    },
    media,
    activity,
  };
}
