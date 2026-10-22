import { z } from "zod";
import { paginationQuery } from "../../lib/pagination.js";
import { ENQUIRY_STATUSES } from "../../types.js";
import { emailSchema } from "../auth/auth.schemas.js";

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const publicEnquirySchema = z.object({
  name: z.string().trim().min(1, "Please tell us your name").max(120),
  email: emailSchema,
  phone: optionalText(40),
  company: optionalText(150),
  service: optionalText(150),
  budget: optionalText(100),
  message: z.string().trim().min(2, "Please write a short message").max(5000),
  source: optionalText(300),
  /** Honeypot: humans never see or fill this field. */
  website: z.string().max(500).optional(),
});

export const enquiryStatusSchema = z.enum(ENQUIRY_STATUSES);

export const enquiryListQuery = paginationQuery.extend({
  q: z.string().trim().max(200).optional(),
  status: enquiryStatusSchema.optional(),
  sort: z.string().trim().max(100).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export const enquiryPatchSchema = z.object({ status: enquiryStatusSchema });

export const enquiryNoteSchema = z.object({
  body: z.string().trim().min(1, "Write a note").max(5000),
});
