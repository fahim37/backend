import type { Request } from "express";
import type { Types } from "mongoose";
import type { z } from "zod";
import { logActivity } from "../../lib/activity.js";
import { toCsv } from "../../lib/csv.js";
import { notFound } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { pageWindow, paginated, parseSort } from "../../lib/pagination.js";
import { escapeRegex } from "../../lib/slug.js";
import { EnquiryModel } from "../../models/enquiry.js";
import type { Enquiry, EnquiryStatus, Paginated } from "../../types.js";
import { notifyNewEnquiry } from "./enquiries.notify.js";
import type { enquiryListQuery, publicEnquirySchema } from "./enquiries.schemas.js";

type ListQuery = z.output<typeof enquiryListQuery>;

const SORT_FIELDS = ["createdAt", "updatedAt", "status", "name", "email"] as const;
const EXPORT_LIMIT = 50_000;

function toJson(doc: unknown): Enquiry {
  return JSON.parse(JSON.stringify(doc)) as Enquiry;
}

function buildFilter(query: Pick<ListQuery, "q" | "status" | "from" | "to">): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), "i");
    filter.$or = ["name", "email", "company", "phone", "service", "message"].map((field) => ({ [field]: pattern }));
  }
  if (query.from || query.to) {
    const range: Record<string, Date> = {};
    if (query.from) range.$gte = new Date(`${query.from}T00:00:00.000Z`);
    if (query.to) range.$lt = new Date(new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000);
    filter.createdAt = range;
  }
  return filter;
}

/**
 * Stores a public enquiry and emails the team in the background. Honeypot
 * submissions are dropped silently by the caller.
 */
export async function createEnquiry(input: z.output<typeof publicEnquirySchema>, req: Request): Promise<void> {
  const { website: _honeypot, ...data } = input;
  void _honeypot;
  const enquiry = await EnquiryModel.create({
    ...data,
    status: "new",
    ip: req.ip,
    userAgent: req.get("user-agent")?.slice(0, 400),
  });
  const enquiryId = String(enquiry._id);
  logger.info({ enquiryId }, "new enquiry received");
  notifyNewEnquiry({
    id: enquiryId,
    name: enquiry.name,
    email: enquiry.email,
    phone: enquiry.phone,
    company: enquiry.company,
    service: enquiry.service,
    budget: enquiry.budget,
    message: enquiry.message,
    source: enquiry.source,
    createdAt: enquiry.createdAt,
  });
}

export async function listEnquiries(query: ListQuery): Promise<Paginated<Enquiry>> {
  const filter = buildFilter(query);
  const sort = parseSort(query.sort, SORT_FIELDS, { createdAt: -1 });
  const { skip, limit } = pageWindow(query);
  const [items, total] = await Promise.all([
    EnquiryModel.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    EnquiryModel.countDocuments(filter),
  ]);
  return paginated(items.map(toJson), total, query);
}

export async function getEnquiry(id: Types.ObjectId): Promise<Enquiry> {
  const doc = await EnquiryModel.findById(id).lean();
  if (!doc) throw notFound("Enquiry not found");
  return toJson(doc);
}

export async function setEnquiryStatus(id: Types.ObjectId, status: EnquiryStatus, req: Request): Promise<Enquiry> {
  const doc = await EnquiryModel.findByIdAndUpdate(id, { $set: { status } }, { new: true, runValidators: true }).lean();
  if (!doc) throw notFound("Enquiry not found");
  await logActivity(req, { action: "update", entity: "enquiries", entityId: id, label: `${doc.name} → ${status}` });
  return toJson(doc);
}

export async function addEnquiryNote(id: Types.ObjectId, body: string, req: Request): Promise<Enquiry> {
  const author = req.auth?.name ?? "Unknown";
  const doc = await EnquiryModel.findByIdAndUpdate(
    id,
    { $push: { notes: { body, author, authorId: req.auth?.userId ?? null, createdAt: new Date() } } },
    { new: true },
  ).lean();
  if (!doc) throw notFound("Enquiry not found");
  await logActivity(req, { action: "update", entity: "enquiries", entityId: id, label: `Note on ${doc.name}` });
  return toJson(doc);
}

export async function removeEnquiryNote(id: Types.ObjectId, noteId: Types.ObjectId, req: Request): Promise<Enquiry> {
  const doc = await EnquiryModel.findOneAndUpdate(
    { _id: id, "notes._id": noteId },
    { $pull: { notes: { _id: noteId } } },
    { new: true },
  ).lean();
  if (!doc) throw notFound("Note not found");
  await logActivity(req, { action: "update", entity: "enquiries", entityId: id, label: `Removed note on ${doc.name}` });
  return toJson(doc);
}

export async function deleteEnquiry(id: Types.ObjectId, req: Request): Promise<void> {
  const doc = await EnquiryModel.findByIdAndDelete(id).lean();
  if (!doc) throw notFound("Enquiry not found");
  await logActivity(req, { action: "delete", entity: "enquiries", entityId: id, label: doc.name });
}

export async function exportEnquiriesCsv(query: Pick<ListQuery, "q" | "status" | "from" | "to">): Promise<string> {
  const docs = await EnquiryModel.find(buildFilter(query)).sort({ createdAt: -1 }).limit(EXPORT_LIMIT).lean();
  const header = ["Received", "Status", "Name", "Email", "Phone", "Company", "Service", "Budget", "Message", "Source", "Notes"];
  const rows = docs.map((doc) => [
    doc.createdAt,
    doc.status,
    doc.name,
    doc.email,
    doc.phone,
    doc.company,
    doc.service,
    doc.budget,
    doc.message,
    doc.source,
    doc.notes.map((note) => `${note.author}: ${note.body}`).join("\n"),
  ]);
  return toCsv(header, rows);
}
