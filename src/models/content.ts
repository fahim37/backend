import mongoose, { Schema, type Model, type SchemaDefinition, type Types } from "mongoose";
import type { CollectionKey, Status } from "../types.js";
import { baseContentFields, defaultSchemaOptions, imageSchema, sectionSchema } from "./shared.js";

/** Common view of a stored content document; collection fields are open-ended. */
export interface ContentRecord {
  _id: Types.ObjectId;
  status: Status;
  order: number;
  createdAt: Date;
  updatedAt: Date;
  [field: string]: unknown;
}

export type ContentModel = Model<ContentRecord>;

type IndexSpec = { fields: Record<string, 1 | -1>; options?: { unique?: boolean } };

function contentModel(name: string, collection: CollectionKey, definition: SchemaDefinition, indexes: IndexSpec[]) {
  const schema = new Schema({ ...baseContentFields, ...definition }, { ...defaultSchemaOptions, collection });
  schema.index({ status: 1, order: 1 });
  schema.index({ order: 1 });
  schema.index({ updatedAt: -1 });
  for (const index of indexes) schema.index(index.fields, index.options);
  const existing = mongoose.models[name] as ContentModel | undefined;
  return existing ?? (mongoose.model(name, schema) as unknown as ContentModel);
}

const unique = (field: string): IndexSpec => ({ fields: { [field]: 1 }, options: { unique: true } });
const byField = (field: string): IndexSpec => ({ fields: { [field]: 1, order: 1 } });

export const SolutionModel = contentModel(
  "Solution",
  "solutions",
  {
    slug: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    category: String,
    group: { type: String, default: null },
    intro: String,
    tagline: String,
    icon: String,
    image: imageSchema,
    features: [String],
    featuredOnHome: { type: Boolean, default: false },
  },
  [unique("slug"), byField("category"), { fields: { featuredOnHome: 1, status: 1, order: 1 } }],
);

export const IndustryModel = contentModel(
  "Industry",
  "industries",
  {
    slug: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    icon: String,
    intro: String,
    description: String,
    features: [String],
    solution: String,
    image: imageSchema,
  },
  [unique("slug")],
);

export const TechnologyModel = contentModel(
  "Technology",
  "technologies",
  {
    slug: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    category: String,
    logo: imageSchema,
    description: String,
  },
  [unique("slug"), byField("category")],
);

export const ProjectModel = contentModel(
  "Project",
  "projects",
  {
    slug: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    label: String,
    image: imageSchema,
    solution: String,
    intro: String,
    challenge: String,
    approach: String,
    features: [String],
  },
  [unique("slug"), byField("solution")],
);

export const ArticleModel = contentModel(
  "Article",
  "articles",
  {
    slug: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    category: String,
    image: imageSchema,
    read: String,
    intro: String,
    sections: [sectionSchema],
    author: String,
    publishedAt: { type: Date, default: () => new Date() },
  },
  [unique("slug"), byField("category"), { fields: { status: 1, publishedAt: -1 } }],
);

export const JobModel = contentModel(
  "Job",
  "jobs",
  {
    slug: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    department: String,
    experience: String,
    location: String,
    employmentType: String,
    skills: [String],
    description: String,
    responsibilities: [String],
  },
  [unique("slug"), byField("department")],
);

export const TeamMemberModel = contentModel(
  "TeamMember",
  "team",
  {
    name: { type: String, required: true, trim: true },
    role: String,
    photo: imageSchema,
    bio: String,
    linkedin: String,
  },
  [],
);

export const ClientModel = contentModel(
  "Client",
  "clients",
  {
    name: { type: String, required: true, trim: true },
    logo: imageSchema,
    url: String,
  },
  [],
);

export const FaqModel = contentModel(
  "Faq",
  "faqs",
  {
    question: { type: String, required: true, trim: true },
    answer: String,
  },
  [],
);

export const PageModel = contentModel(
  "Page",
  "pages",
  {
    key: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    eyebrow: String,
    heading: String,
    description: String,
    image: { type: imageSchema, default: undefined },
    sections: [sectionSchema],
  },
  [unique("key")],
);

export const RedirectModel = contentModel(
  "Redirect",
  "redirects",
  {
    from: { type: String, required: true, trim: true },
    to: { type: String, required: true, trim: true },
    permanent: { type: Boolean, default: true },
  },
  [unique("from")],
);

/** Every content model keyed by its collection name. */
export const contentModels: Record<CollectionKey, ContentModel> = {
  solutions: SolutionModel,
  industries: IndustryModel,
  technologies: TechnologyModel,
  projects: ProjectModel,
  articles: ArticleModel,
  jobs: JobModel,
  team: TeamMemberModel,
  clients: ClientModel,
  faqs: FaqModel,
  pages: PageModel,
  redirects: RedirectModel,
};
