import type { z } from "zod";
import { contentModels, type ContentModel } from "../../models/content.js";
import { createSchemas, updateSchemas } from "../../schemas/content.js";
import { COLLECTION_KEYS, type CollectionKey } from "../../types.js";

export type FilterKind = "string" | "boolean";

export type CollectionConfig = {
  key: CollectionKey;
  model: ContentModel;
  /** Field used as the human label in activity entries and duplicates. */
  labelField: "title" | "name" | "question" | "from";
  /** Unique, URL-facing identifier, or null when the collection has none. */
  uniqueField: "slug" | "key" | "from" | null;
  /** Field the unique identifier is generated from when omitted on create. */
  slugSource: "title" | null;
  /** Fields matched (case-insensitive, partial) by `?q=`. */
  searchFields: readonly string[];
  /** Extra exact-match list filters accepted as query parameters. */
  filters: Readonly<Record<string, FilterKind>>;
  /** Fields accepted by `?sort=`. */
  sortFields: readonly string[];
  createSchema: z.ZodObject;
  updateSchema: z.ZodObject;
};

const COMMON_SORT = ["order", "updatedAt", "createdAt", "status"] as const;

type ConfigInput = Omit<CollectionConfig, "key" | "model" | "createSchema" | "updateSchema" | "sortFields"> & {
  extraSort?: readonly string[];
};

const definitions: Record<CollectionKey, ConfigInput> = {
  solutions: {
    labelField: "title",
    uniqueField: "slug",
    slugSource: "title",
    searchFields: ["title", "slug", "tagline", "category"],
    filters: { category: "string", group: "string", featuredOnHome: "boolean" },
    extraSort: ["category"],
  },
  industries: {
    labelField: "title",
    uniqueField: "slug",
    slugSource: "title",
    searchFields: ["title", "slug", "intro"],
    filters: { solution: "string" },
  },
  technologies: {
    labelField: "title",
    uniqueField: "slug",
    slugSource: "title",
    searchFields: ["title", "slug", "category"],
    filters: { category: "string" },
    extraSort: ["category"],
  },
  projects: {
    labelField: "title",
    uniqueField: "slug",
    slugSource: "title",
    searchFields: ["title", "slug", "label"],
    filters: { solution: "string" },
  },
  articles: {
    labelField: "title",
    uniqueField: "slug",
    slugSource: "title",
    searchFields: ["title", "slug", "category", "author"],
    filters: { category: "string" },
    extraSort: ["publishedAt", "category"],
  },
  jobs: {
    labelField: "title",
    uniqueField: "slug",
    slugSource: "title",
    searchFields: ["title", "slug", "department", "location"],
    filters: { department: "string" },
    extraSort: ["department"],
  },
  team: {
    labelField: "name",
    uniqueField: null,
    slugSource: null,
    searchFields: ["name", "role"],
    filters: {},
  },
  clients: {
    labelField: "name",
    uniqueField: null,
    slugSource: null,
    searchFields: ["name", "url"],
    filters: {},
  },
  faqs: {
    labelField: "question",
    uniqueField: null,
    slugSource: null,
    searchFields: ["question", "answer"],
    filters: {},
  },
  pages: {
    labelField: "title",
    uniqueField: "key",
    slugSource: "title",
    searchFields: ["title", "key", "eyebrow"],
    filters: {},
  },
  redirects: {
    labelField: "from",
    uniqueField: "from",
    slugSource: null,
    searchFields: ["from", "to"],
    filters: { permanent: "boolean" },
  },
};

/** Per-collection configuration driving the generic content router and public reads. */
export const contentRegistry = Object.fromEntries(
  COLLECTION_KEYS.map((key) => {
    const { extraSort = [], ...definition } = definitions[key];
    const sortFields = [
      ...COMMON_SORT,
      definition.labelField,
      ...(definition.uniqueField ? [definition.uniqueField] : []),
      ...extraSort,
    ];
    const config: CollectionConfig = {
      key,
      model: contentModels[key],
      createSchema: createSchemas[key],
      updateSchema: updateSchemas[key],
      sortFields: [...new Set(sortFields)],
      ...definition,
    };
    return [key, config];
  }),
) as Record<CollectionKey, CollectionConfig>;

export function isCollectionKey(value: unknown): value is CollectionKey {
  return typeof value === "string" && (COLLECTION_KEYS as readonly string[]).includes(value);
}

export function getCollectionConfig(key: CollectionKey): CollectionConfig {
  return contentRegistry[key];
}
