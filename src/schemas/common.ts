import { z } from "zod";
import { objectIdString } from "../lib/object-id.js";
import { SLUG_PATTERN } from "../lib/slug.js";
import { ICONS } from "../types.js";

// Missing fields read "Required" instead of "expected string, received undefined".
z.config({
  customError: (issue) => (issue.code === "invalid_type" && issue.input === undefined ? "Required" : undefined),
});

/** Trimmed string up to `max` characters; empty allowed. */
export const text = (max = 2000) => z.string().trim().max(max);
/** Trimmed, non-empty string up to `max` characters. */
export const requiredText = (max = 200) => z.string().trim().min(1, "Required").max(max);
/** Long-form copy (articles, descriptions). */
export const longText = (max = 50_000) => z.string().max(max);

export const statusSchema = z.enum(["published", "draft"]);
export const iconSchema = z.enum(ICONS);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Required")
  .max(120)
  .regex(SLUG_PATTERN, "Use lowercase letters, numbers and single hyphens");

/** Absolute http(s) URL, or a site-relative path. */
export const hrefSchema = z
  .string()
  .trim()
  .min(1, "Required")
  .max(2048)
  .regex(/^(https?:\/\/|\/|#|mailto:|tel:)\S*$/i, "Use an absolute URL, a path starting with /, #anchor, mailto: or tel:");

/** Optional absolute URL; an empty string clears it. */
export const optionalUrl = z
  .union([z.literal(""), z.url({ protocol: /^https?$/ }).max(2048)])
  .optional();

const imageUrl = z
  .string()
  .trim()
  .min(1, "Image URL is required")
  .max(2048)
  .regex(/^(https:\/\/|http:\/\/|\/)\S+$/i, "Use an https URL or a site path starting with /");

export const cropSchema = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const focalSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export const cmsImageSchema = z.object({
  url: imageUrl,
  publicId: z.string().trim().max(512).optional(),
  mediaId: z.union([z.literal(""), objectIdString]).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  alt: text(500).optional(),
  crop: cropSchema.nullable().optional(),
  aspect: z.string().trim().max(16).nullable().optional(),
  focal: focalSchema.nullable().optional(),
});

export const seoSchema = z.object({
  title: text(200).optional(),
  description: text(500).optional(),
  image: cmsImageSchema.nullable().optional(),
  noindex: z.boolean().optional(),
  canonical: text(2048).optional(),
  keywords: z.array(text(100)).max(50).optional(),
  priority: z.number().min(0).max(1).optional(),
  changeFrequency: z.enum(["daily", "weekly", "monthly", "yearly"]).optional(),
});

export const linkSchema = z.object({
  label: requiredText(120),
  href: hrefSchema,
});

export const stringList = (maxItems = 100, maxLength = 500) => z.array(requiredText(maxLength)).max(maxItems);

/** Accepts an ISO date or date-time string (or Date) and yields a Date. */
export const dateInput = z
  .union([z.date(), z.iso.datetime({ offset: true }), z.iso.date()])
  .transform((value) => (value instanceof Date ? value : new Date(value)));

/** Fields shared by every content document. */
export const baseContentShape = {
  status: statusSchema,
  order: z.number().int().min(0).max(1_000_000),
  seo: seoSchema.optional(),
};
