import { z } from "zod";
import {
  SERVICE_GROUPS,
  SOLUTION_CATEGORIES,
  TECHNOLOGY_CATEGORIES,
  type CollectionKey,
} from "../types.js";
import {
  baseContentShape,
  cmsImageSchema,
  dateInput,
  iconSchema,
  longText,
  optionalUrl,
  requiredText,
  slugSchema,
  stringList,
  text,
} from "./common.js";

const serviceGroupKeys = SERVICE_GROUPS.map((group) => group.key) as [
  (typeof SERVICE_GROUPS)[number]["key"],
  ...(typeof SERVICE_GROUPS)[number]["key"][],
];

const sectionSchema = z.object({
  heading: text(200),
  body: longText(),
});

const redirectPath = z
  .string()
  .trim()
  .min(1, "Required")
  .max(1024)
  .regex(/^\/[^\s?#]*$/, "Use a site path starting with / (no query string)")
  .transform((value) => (value.length > 1 ? value.replace(/\/+$/, "") : value));

const redirectTarget = z
  .string()
  .trim()
  .min(1, "Required")
  .max(2048)
  .regex(/^(\/|https?:\/\/)\S*$/i, "Use a path starting with / or an absolute http(s) URL");

/** Page keys are path-like: "about", "privacy", "legal/terms". */
const pageKey = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Required")
  .max(120)
  .regex(/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/, "Use lowercase letters, numbers, hyphens and /");

/**
 * Full document shapes (no defaults). `createSchemas` validate a complete
 * document after defaults are merged in; `updateSchemas` are the partial
 * variants used by PATCH, so absent fields are left untouched.
 */
export const contentShapes = {
  solutions: z.object({
    ...baseContentShape,
    slug: slugSchema,
    title: requiredText(200),
    category: z.enum(SOLUTION_CATEGORIES),
    group: z.enum(serviceGroupKeys).nullable(),
    intro: text(2000),
    tagline: text(300),
    icon: iconSchema,
    image: cmsImageSchema,
    features: stringList(50, 300),
    featuredOnHome: z.boolean(),
  }),
  industries: z.object({
    ...baseContentShape,
    slug: slugSchema,
    title: requiredText(200),
    icon: iconSchema,
    intro: text(2000),
    description: longText(20_000),
    features: stringList(50, 300),
    solution: z.union([z.literal(""), slugSchema]),
    image: cmsImageSchema,
  }),
  technologies: z.object({
    ...baseContentShape,
    slug: slugSchema,
    title: requiredText(200),
    category: z.enum(TECHNOLOGY_CATEGORIES),
    logo: cmsImageSchema,
    description: longText(20_000).optional(),
  }),
  projects: z.object({
    ...baseContentShape,
    slug: slugSchema,
    title: requiredText(200),
    label: text(200),
    image: cmsImageSchema,
    solution: z.union([z.literal(""), slugSchema]),
    intro: text(4000),
    challenge: longText(20_000),
    approach: longText(20_000),
    features: stringList(50, 300),
  }),
  articles: z.object({
    ...baseContentShape,
    slug: slugSchema,
    title: requiredText(250),
    category: requiredText(100),
    image: cmsImageSchema,
    read: text(50),
    intro: text(4000),
    sections: z.array(sectionSchema).max(100),
    author: text(120).optional(),
    publishedAt: dateInput,
  }),
  jobs: z.object({
    ...baseContentShape,
    slug: slugSchema,
    title: requiredText(200),
    department: requiredText(120),
    experience: text(120),
    location: text(200).optional(),
    employmentType: text(100).optional(),
    skills: stringList(50, 100),
    description: longText(20_000),
    responsibilities: stringList(50, 500).optional(),
  }),
  team: z.object({
    ...baseContentShape,
    name: requiredText(150),
    role: text(150),
    photo: cmsImageSchema,
    bio: text(4000).optional(),
    linkedin: optionalUrl,
  }),
  clients: z.object({
    ...baseContentShape,
    name: requiredText(150),
    logo: cmsImageSchema,
    url: optionalUrl,
  }),
  faqs: z.object({
    ...baseContentShape,
    question: requiredText(500),
    answer: longText(10_000).pipe(z.string().trim().min(1, "Required")),
  }),
  pages: z.object({
    ...baseContentShape,
    key: pageKey,
    title: requiredText(200),
    eyebrow: text(200).optional(),
    heading: text(500).optional(),
    description: text(4000).optional(),
    image: cmsImageSchema.nullable().optional(),
    sections: z.array(sectionSchema).max(100),
  }),
  redirects: z.object({
    ...baseContentShape,
    from: redirectPath,
    to: redirectTarget,
    permanent: z.boolean(),
  }),
} satisfies Record<CollectionKey, z.ZodObject>;

export type ContentShapes = typeof contentShapes;
export type ContentInput<K extends CollectionKey> = z.output<ContentShapes[K]>;

export const createSchemas = contentShapes;

export const updateSchemas = Object.fromEntries(
  Object.entries(contentShapes).map(([key, schema]) => [key, schema.partial()]),
) as { [K in CollectionKey]: ReturnType<ContentShapes[K]["partial"]> };

/**
 * Values merged under the request body before a create is validated, so the
 * admin (and the seed) only has to send what it knows. `status` defaults to
 * draft; `order` and the slug/key are computed by the content service.
 */
export const contentDefaults: { [K in CollectionKey]: Record<string, unknown> } = {
  solutions: { status: "draft", group: null, intro: "", tagline: "", icon: "spark", features: [], featuredOnHome: false },
  industries: { status: "draft", icon: "building", intro: "", description: "", features: [], solution: "" },
  technologies: { status: "draft" },
  projects: { status: "draft", label: "", solution: "", intro: "", challenge: "", approach: "", features: [] },
  articles: { status: "draft", read: "", intro: "", sections: [], publishedAt: () => new Date().toISOString() },
  jobs: { status: "draft", experience: "", skills: [], description: "", responsibilities: [] },
  team: { status: "draft", role: "" },
  clients: { status: "draft" },
  faqs: { status: "draft" },
  pages: { status: "draft", sections: [] },
  redirects: { status: "published", permanent: true },
};

/** Resolves defaults (function values are evaluated per call). */
export function resolveDefaults(key: CollectionKey): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(contentDefaults[key])) {
    resolved[field] = typeof value === "function" ? (value as () => unknown)() : value;
  }
  return resolved;
}
