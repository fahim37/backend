import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Values already present in the process environment win over server/.env.
dotenv.config({ path: path.join(serverRoot, ".env"), quiet: true });

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().trim().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: optionalString,
  /**
   * Reverse-proxy hops in front of the API (production only). 1 = nginx;
   * 2 = Vercel rewrite + nginx, so req.ip is the visitor rather than Vercel.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** A MongoDB connection string, or "memory" to run an in-process mongodb-memory-server. */
  MONGODB_URI: z.string().trim().min(1, "MONGODB_URI is required (use \"memory\" for an in-process database)"),
  MONGODB_DB: z.string().trim().min(1).default("srsit"),

  CLOUDINARY_CLOUD_NAME: optionalString,
  CLOUDINARY_API_KEY: optionalString,
  CLOUDINARY_API_SECRET: optionalString,
  CLOUDINARY_FOLDER: z.preprocess(emptyToUndefined, z.string().trim().default("srsit")),

  JWT_ACCESS_SECRET: z.preprocess(emptyToUndefined, z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters").optional()),
  JWT_REFRESH_SECRET: z.preprocess(emptyToUndefined, z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters").optional()),
  JWT_ISSUER: z.string().default("srsit-cms-api"),
  JWT_AUDIENCE: z.string().default("srsit-cms-admin"),

  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim().replace(/\/+$/, ""))
        .filter(Boolean),
    ),
  SITE_URL: z.preprocess(emptyToUndefined, z.url().optional()).transform((value) => value?.replace(/\/+$/, "")),
  REVALIDATE_SECRET: optionalString,

  ADMIN_EMAIL: z.preprocess(emptyToUndefined, z.email().optional()),
  ADMIN_PASSWORD: optionalString,
  ADMIN_NAME: z.preprocess(emptyToUndefined, z.string().trim().default("Administrator")),

  /** Outgoing email (enquiry notifications). Email stays off while SMTP_HOST is empty. */
  SMTP_HOST: optionalString,
  SMTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(587)),
  /** Implicit TLS. Defaults to true on port 465 and false otherwise (STARTTLS is still used when offered). */
  SMTP_SECURE: z.preprocess(emptyToUndefined, z.stringbool().optional()),
  SMTP_USER: optionalString,
  /** Not trimmed: passwords may legitimately start or end with spaces. */
  SMTP_PASS: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Sender, e.g. `SRS IT Website <no-reply@example.com>`. Defaults to SMTP_USER when that is an address. */
  MAIL_FROM: optionalString,
  /** "json" renders messages without delivering them (tests and local debugging). */
  MAIL_TRANSPORT: z.preprocess(emptyToUndefined, z.enum(["smtp", "json"]).default("smtp")),
  /** Base URL of the admin site for links in emails; defaults to SITE_URL. */
  ADMIN_URL: z.preprocess(emptyToUndefined, z.url().optional()).transform((value) => value?.replace(/\/+$/, "")),
});

export type Env = z.infer<typeof envSchema> & {
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  isProduction: boolean;
  isMemoryDb: boolean;
  serverRoot: string;
  warnings: string[];
};

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join(".") || "env"}: ${issue.message}`);
    // The logger depends on env, so configuration errors go straight to stderr.
    console.error(`Invalid server environment:\n${lines.join("\n")}`);
    process.exit(1);
  }

  const data = parsed.data;
  const isProduction = data.NODE_ENV === "production";
  const warnings: string[] = [];

  const secret = (name: "JWT_ACCESS_SECRET" | "JWT_REFRESH_SECRET"): string => {
    const value = data[name];
    if (value) return value;
    if (isProduction) {
      console.error(`Invalid server environment:\n  - ${name}: required in production`);
      process.exit(1);
    }
    warnings.push(`${name} is not set; using an ephemeral random secret (sessions will not survive restarts).`);
    return randomBytes(48).toString("base64url");
  };

  if (data.SITE_URL && !data.REVALIDATE_SECRET) {
    warnings.push("SITE_URL is set but REVALIDATE_SECRET is missing; site revalidation requests will be rejected.");
  }

  return {
    ...data,
    JWT_ACCESS_SECRET: secret("JWT_ACCESS_SECRET"),
    JWT_REFRESH_SECRET: secret("JWT_REFRESH_SECRET"),
    isProduction,
    isMemoryDb: data.MONGODB_URI.toLowerCase() === "memory",
    serverRoot,
    warnings,
  };
}

export const env = loadEnv();
