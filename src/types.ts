// Mirror of lib/cms/types.ts (the shared CMS contract). Keep in sync by copying;
// the API never imports across the package boundary at runtime.

export type Status = "published" | "draft";

/** Icon names understood by components/ui.tsx <Icon>. */
export const ICONS = [
  "arrow", "diagonal", "chevron", "plus", "minus", "close", "menu", "search",
  "code", "mobile", "cart", "layers", "cloud", "spark", "globe", "box", "users",
  "building", "chart", "heart", "truck", "network", "mail", "message", "shield",
  "scan", "printer", "book", "briefcase", "check", "pin", "phone", "clock",
  "play", "download", "copy",
] as const;
export type IconName = (typeof ICONS)[number];

/**
 * An image reference stored on content. `url` is always usable as-is: the
 * Cloudinary secure URL of the original upload, or a local "/assets/..." path
 * for bundled fallback content. `crop` is a pixel rectangle in the original
 * image chosen in the admin cropper; renderers apply it before resizing.
 */
export type CmsImage = {
  url: string;
  publicId?: string;
  mediaId?: string;
  width?: number;
  height?: number;
  alt?: string;
  crop?: { x: number; y: number; width: number; height: number } | null;
  /** Aspect preset chosen in the cropper, e.g. "16:9", "4:3", "1:1", "free". */
  aspect?: string | null;
  /** Focal point (0..1) used for object-position when an image is covered. */
  focal?: { x: number; y: number } | null;
};

export type Seo = {
  title?: string;
  description?: string;
  image?: CmsImage | null;
  noindex?: boolean;
  canonical?: string;
  keywords?: string[];
  /** Sitemap tuning. */
  priority?: number;
  changeFrequency?: "daily" | "weekly" | "monthly" | "yearly";
};

export type Link = { label: string; href: string };

type Base = {
  _id: string;
  status: Status;
  order: number;
  seo?: Seo;
  createdAt: string;
  updatedAt: string;
};

export const SOLUTION_CATEGORIES = [
  "Development", "Software", "Marketing", "Infrastructure", "Products",
] as const;
export type SolutionCategory = (typeof SOLUTION_CATEGORIES)[number];

export const SERVICE_GROUPS = [
  { key: "design-development", title: "Design & Development" },
  { key: "erp-business", title: "ERP & Business Management" },
  { key: "people-operations", title: "People & Operations" },
  { key: "cloud-marketing", title: "Cloud & Digital Marketing" },
] as const;
export type ServiceGroupKey = (typeof SERVICE_GROUPS)[number]["key"];

export type Solution = Base & {
  slug: string;
  title: string;
  category: SolutionCategory;
  /** Service-explorer group; null keeps it out of the grouped menus (e.g. Products). */
  group: ServiceGroupKey | null;
  intro: string;
  tagline: string;
  icon: IconName;
  image: CmsImage;
  features: string[];
  /** Shown in the homepage service stage, ordered by `order`. */
  featuredOnHome: boolean;
};

export type Industry = Base & {
  slug: string;
  title: string;
  icon: IconName;
  intro: string;
  description: string;
  features: string[];
  /** Related solution slug. */
  solution: string;
  image: CmsImage;
};

export const TECHNOLOGY_CATEGORIES = [
  "Frontend", "Backend", "Database", "Cloud & Tools",
] as const;
export type Technology = Base & {
  slug: string;
  title: string;
  category: (typeof TECHNOLOGY_CATEGORIES)[number];
  logo: CmsImage;
  /** Optional long description; the site falls back to generated copy. */
  description?: string;
};

export type Project = Base & {
  slug: string;
  title: string;
  label: string;
  image: CmsImage;
  /** Related solution slug. */
  solution: string;
  intro: string;
  challenge: string;
  approach: string;
  features: string[];
};

export type ArticleSection = { heading: string; body: string };
export type Article = Base & {
  slug: string;
  title: string;
  category: string;
  image: CmsImage;
  /** e.g. "5 min read" */
  read: string;
  intro: string;
  sections: ArticleSection[];
  author?: string;
  publishedAt: string;
};

export type Job = Base & {
  slug: string;
  title: string;
  department: string;
  experience: string;
  location?: string;
  employmentType?: string;
  skills: string[];
  description: string;
  responsibilities?: string[];
};

export type TeamMember = Base & {
  name: string;
  role: string;
  photo: CmsImage;
  bio?: string;
  linkedin?: string;
};

export type Client = Base & {
  name: string;
  logo: CmsImage;
  url?: string;
};

export type Faq = Base & { question: string; answer: string };

export type PageSection = { heading: string; body: string };
/** Editable copy for core pages, keyed by path ("about", "privacy", ...). */
export type Page = Base & {
  key: string;
  title: string;
  eyebrow?: string;
  /** Use "\n" for line breaks. */
  heading?: string;
  description?: string;
  image?: CmsImage | null;
  sections: PageSection[];
};

export type Redirect = Base & { from: string; to: string; permanent: boolean };

export type CollectionMap = {
  solutions: Solution;
  industries: Industry;
  technologies: Technology;
  projects: Project;
  articles: Article;
  jobs: Job;
  team: TeamMember;
  clients: Client;
  faqs: Faq;
  pages: Page;
  redirects: Redirect;
};
export type CollectionKey = keyof CollectionMap;
export const COLLECTION_KEYS = [
  "solutions", "industries", "technologies", "projects", "articles", "jobs",
  "team", "clients", "faqs", "pages", "redirects",
] as const satisfies readonly CollectionKey[];

// ---- Singletons (settings/:key) ----

export type SiteSettings = {
  company: {
    name: string;
    tagline: string;
    email: string;
    phone: string;
    support: string;
    address: string;
    hours: string;
  };
  social: { facebook?: string; linkedin?: string; youtube?: string; x?: string; instagram?: string };
  seo: { defaultTitle: string; titleTemplate: string; description: string; ogImage?: CmsImage | null };
  cta: { eyebrow: string; title: string; description: string; button: Link };
  footer: { blurb: string };
  logo?: CmsImage | null;
  /** Inbox notification address for new enquiries. */
  notificationEmail?: string;
  /** Tracking + verification, rendered by the site only when set. */
  analytics?: {
    gtmId?: string; // GTM-XXXXXXX
    ga4Id?: string; // G-XXXXXXXXXX (skipped when GTM manages GA4)
    metaPixelId?: string;
    clarityId?: string;
    googleVerification?: string;
    bingVerification?: string;
    facebookDomainVerification?: string;
    /** Google Consent Mode v2 defaults + cookie banner. */
    consentMode?: boolean;
  };
  /** Structured data for the organisation (JSON-LD). */
  schema?: {
    type: "Organization" | "LocalBusiness" | "ProfessionalService";
    legalName?: string;
    foundingYear?: string;
    priceRange?: string;
    geo?: { lat: number; lng: number } | null;
    sameAs?: string[];
  };
  robots?: { indexSite: boolean; extraDisallow?: string[] };
};

export type HomeSettings = {
  hero: {
    kicker: string;
    /** Use "\n" for line breaks; `highlight` is rendered in the accent colour at the end. */
    title: string;
    highlight: string;
    description: string;
    primaryCta: Link;
    secondaryCta: Link;
    proofValue: string;
    proofText: string;
    locationText: string;
    floatText: string;
  };
  rotatingPhrases: string[];
  outcomes: { icon: IconName; title: string; text: string }[];
  automation: { icon: IconName; title: string; text: string; href: string }[];
  about: { eyebrow: string; title: string; description: string; body: string; image: CmsImage; since: string };
  stats: { value: string; label: string }[];
  relationship: { title: string; text: string }[];
  contact: { eyebrow: string; title: string; highlight: string; description: string };
};

export type SettingsMap = { site: SiteSettings; home: HomeSettings };
export type SettingsKey = keyof SettingsMap;

/** GET /api/public/bundle — everything the public site renders (published only). */
export type PublicBundle = { [K in CollectionKey]: CollectionMap[K][] } & {
  site: SiteSettings;
  home: HomeSettings;
  /** ISO timestamp of the most recent content change. */
  version: string;
};

// ---- Admin-only records ----

export type Role = "admin" | "editor" | "viewer";
export type User = {
  _id: string;
  name: string;
  email: string;
  role: Role;
  avatar?: CmsImage | null;
  active: boolean;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type Media = {
  _id: string;
  publicId: string;
  url: string;
  format: string;
  resourceType: "image" | "video" | "raw";
  width: number;
  height: number;
  bytes: number;
  folder: string;
  alt: string;
  title: string;
  tags: string[];
  /** Low-res base64 data URL for blur placeholders. */
  blurDataURL?: string;
  uploadedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export const ENQUIRY_STATUSES = ["new", "in-progress", "replied", "won", "lost", "archived"] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];
export type Enquiry = {
  _id: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  service?: string;
  budget?: string;
  message: string;
  source?: string;
  status: EnquiryStatus;
  notes: { _id: string; body: string; author: string; createdAt: string }[];
  ip?: string;
  userAgent?: string;
  createdAt: string;
  updatedAt: string;
};

export type Activity = {
  _id: string;
  user?: { _id: string; name: string; email: string } | null;
  action: "create" | "update" | "delete" | "publish" | "unpublish" | "reorder" | "upload" | "login" | "settings" | "revalidate";
  entity: string;
  entityId?: string;
  label?: string;
  createdAt: string;
};

export type Paginated<T> = { items: T[]; total: number; page: number; limit: number; pages: number };

export type DashboardStats = {
  counts: Record<CollectionKey | "media" | "enquiries" | "users", number>;
  drafts: number;
  enquiries: { byStatus: Record<EnquiryStatus, number>; daily: { date: string; count: number }[]; recent: Enquiry[] };
  media: { count: number; bytes: number };
  activity: Activity[];
};

export type ApiError = { error: { message: string; code: string; details?: unknown } };
