import { Router } from "express";
import { requireObjectId } from "../../lib/object-id.js";
import { enquiryLimiter } from "../../middleware/rate-limit.js";
import { parseBody, parseQuery } from "../../middleware/validate.js";
import { enquiryListQuery, enquiryNoteSchema, enquiryPatchSchema, publicEnquirySchema } from "./enquiries.schemas.js";
import {
  addEnquiryNote,
  createEnquiry,
  deleteEnquiry,
  exportEnquiriesCsv,
  getEnquiry,
  listEnquiries,
  removeEnquiryNote,
  setEnquiryStatus,
} from "./enquiries.service.js";

/** Public contact form endpoint, mounted at /api/public/enquiries. */
export const publicEnquiryRouter = Router();

publicEnquiryRouter.post("/", enquiryLimiter, async (req, res) => {
  const body: unknown = req.body;
  const honeypot = body && typeof body === "object" && "website" in body ? body.website : undefined;
  // Bots that fill the hidden field get the same response as a real submission.
  if (typeof honeypot === "string" && honeypot.trim() !== "") {
    req.log?.info("enquiry honeypot triggered");
    res.status(201).json({ ok: true });
    return;
  }
  await createEnquiry(parseBody(publicEnquirySchema, req), req);
  res.status(201).json({ ok: true });
});

/** Admin enquiry inbox, mounted at /api/admin/enquiries. */
export const adminEnquiryRouter = Router();

adminEnquiryRouter.get("/", async (req, res) => {
  res.json(await listEnquiries(parseQuery(enquiryListQuery, req)));
});

adminEnquiryRouter.get("/export.csv", async (req, res) => {
  const query = parseQuery(enquiryListQuery, req);
  const csv = await exportEnquiriesCsv(query);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="enquiries-${stamp}.csv"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(csv);
});

adminEnquiryRouter.get("/:id", async (req, res) => {
  res.json(await getEnquiry(requireObjectId(req.params.id, "Enquiry")));
});

adminEnquiryRouter.patch("/:id", async (req, res) => {
  const { status } = parseBody(enquiryPatchSchema, req);
  res.json(await setEnquiryStatus(requireObjectId(req.params.id, "Enquiry"), status, req));
});

adminEnquiryRouter.post("/:id/notes", async (req, res) => {
  const { body } = parseBody(enquiryNoteSchema, req);
  res.status(201).json(await addEnquiryNote(requireObjectId(req.params.id, "Enquiry"), body, req));
});

adminEnquiryRouter.delete("/:id/notes/:noteId", async (req, res) => {
  const id = requireObjectId(req.params.id, "Enquiry");
  res.json(await removeEnquiryNote(id, requireObjectId(req.params.noteId, "Note"), req));
});

adminEnquiryRouter.delete("/:id", async (req, res) => {
  await deleteEnquiry(requireObjectId(req.params.id, "Enquiry"), req);
  res.json({ ok: true });
});
