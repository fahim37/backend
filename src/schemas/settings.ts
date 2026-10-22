import { z } from "zod";
import type { HomeSettings, SettingsKey, SiteSettings } from "../types.js";
import { cmsImageSchema, hrefSchema, iconSchema, linkSchema, optionalUrl, text } from "./common.js";

const iconCard = z.object({
  icon: iconSchema,
  title: text(200),
  text: text(1000),
});

export const siteSettingsSchema = z.object({
  company: z.object({
    name: text(150),
    tagline: text(300),
    email: z.union([z.literal(""), z.email()]),
    phone: text(60),
    support: text(200),
    address: text(500),
    hours: text(200),
  }),
  social: z.object({
    facebook: optionalUrl,
    linkedin: optionalUrl,
    youtube: optionalUrl,
    x: optionalUrl,
    instagram: optionalUrl,
  }),
  seo: z.object({
    defaultTitle: text(200),
    titleTemplate: text(200),
    description: text(500),
    ogImage: cmsImageSchema.nullable().optional(),
  }),
  cta: z.object({
    eyebrow: text(120),
    title: text(300),
    description: text(1000),
    button: linkSchema,
  }),
  footer: z.object({ blurb: text(1000) }),
  logo: cmsImageSchema.nullable().optional(),
  notificationEmail: z.union([z.literal(""), z.email()]).optional(),
  analytics: z
    .object({
      gtmId: text(50).optional(),
      ga4Id: text(50).optional(),
      metaPixelId: text(50).optional(),
      clarityId: text(50).optional(),
      googleVerification: text(200).optional(),
      bingVerification: text(200).optional(),
      facebookDomainVerification: text(200).optional(),
      consentMode: z.boolean().optional(),
    })
    .optional(),
  schema: z
    .object({
      type: z.enum(["Organization", "LocalBusiness", "ProfessionalService"]),
      legalName: text(200).optional(),
      foundingYear: text(20).optional(),
      priceRange: text(50).optional(),
      geo: z
        .object({
          lat: z.number(),
          lng: z.number(),
        })
        .nullable()
        .optional(),
      sameAs: z.array(text(2048)).max(50).optional(),
    })
    .optional(),
  robots: z
    .object({
      indexSite: z.boolean(),
      extraDisallow: z.array(text(500)).max(50).optional(),
    })
    .optional(),
});

export const homeSettingsSchema = z.object({
  hero: z.object({
    kicker: text(200),
    title: text(300),
    highlight: text(200),
    description: text(1000),
    primaryCta: linkSchema,
    secondaryCta: linkSchema,
    proofValue: text(50),
    proofText: text(200),
    locationText: text(200),
    floatText: text(200),
  }),
  rotatingPhrases: z.array(text(200)).max(20),
  outcomes: z.array(iconCard).max(20),
  automation: z.array(iconCard.extend({ href: hrefSchema })).max(20),
  about: z.object({
    eyebrow: text(120),
    title: text(300),
    description: text(1000),
    body: text(5000),
    image: cmsImageSchema,
    since: text(20),
  }),
  stats: z.array(z.object({ value: text(30), label: text(120) })).max(12),
  relationship: z.array(z.object({ title: text(200), text: text(1000) })).max(12),
  contact: z.object({
    eyebrow: text(120),
    title: text(300),
    highlight: text(200),
    description: text(1000),
  }),
});

export const SETTINGS_KEYS = ["site", "home"] as const satisfies readonly SettingsKey[];

export const settingsSchemas = {
  site: siteSettingsSchema,
  home: homeSettingsSchema,
} satisfies Record<SettingsKey, z.ZodObject>;

// Compile-time check that the schemas produce the contract types.
type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;
export type _SiteSettingsMatches = Assert<Extends<z.output<typeof siteSettingsSchema>, SiteSettings>>;
export type _HomeSettingsMatches = Assert<Extends<z.output<typeof homeSettingsSchema>, HomeSettings>>;

/**
 * Structurally valid empty settings returned before anything has been saved
 * (the seed script populates real content from the site's bundled data).
 */
export const emptySettings: { site: SiteSettings; home: HomeSettings } = {
  site: {
    company: { name: "", tagline: "", email: "", phone: "", support: "", address: "", hours: "" },
    social: {},
    seo: { defaultTitle: "", titleTemplate: "%s", description: "", ogImage: null },
    cta: { eyebrow: "", title: "", description: "", button: { label: "Contact us", href: "/contact" } },
    footer: { blurb: "" },
    logo: null,
  },
  home: {
    hero: {
      kicker: "",
      title: "",
      highlight: "",
      description: "",
      primaryCta: { label: "Get started", href: "/contact" },
      secondaryCta: { label: "Our solutions", href: "/solutions" },
      proofValue: "",
      proofText: "",
      locationText: "",
      floatText: "",
    },
    rotatingPhrases: [],
    outcomes: [],
    automation: [],
    about: { eyebrow: "", title: "", description: "", body: "", image: { url: "/assets/SRS-IT-LOGO.webp", alt: "" }, since: "" },
    stats: [],
    relationship: [],
    contact: { eyebrow: "", title: "", highlight: "", description: "" },
  },
};
