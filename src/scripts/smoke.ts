/**
 * End-to-end smoke test of the CMS API.
 *
 *   npm run smoke
 *
 * Boots the real app (createApp) against an in-memory MongoDB on a random
 * port, plus a tiny HTTP listener that plays the Next.js site so revalidation
 * webhooks can be asserted. Everything goes over HTTP with a cookie jar, like
 * the admin panel. When Cloudinary credentials are configured, a generated PNG
 * is uploaded, edited, checked for usage and deleted again; the Cloudinary
 * account is left exactly as it was. Exits non-zero on any failure.
 *
 * SMOKE_LOG_LEVEL=info npm run smoke   # show API request logs while debugging
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync } from "node:zlib";

// ── Fake site (receives revalidation webhooks) ───────────────────────────────

type Webhook = { secret: string | undefined; body: unknown; at: number };
const webhooks: Webhook[] = [];

const site = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/api/revalidate") {
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // keep the raw text; the assertion will report it
      }
      const secret = req.headers["x-revalidate-secret"];
      webhooks.push({ secret: Array.isArray(secret) ? secret[0] : secret, body, at: Date.now() });
      res.writeHead(200, { "content-type": "application/json" }).end('{"revalidated":true}');
      return;
    }
    res.writeHead(404).end();
  });
});

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

const sitePort = await listen(site);

// ── Environment (must be set before any module reads config/env) ─────────────

const runId = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const secret = randomBytes(24).toString("hex");
const adminEmail = `smoke-admin-${runId}@example.com`;
const adminPassword = `Smoke-${randomBytes(12).toString("base64url")}`;

Object.assign(process.env, {
  NODE_ENV: "test",
  MONGODB_URI: "memory",
  MONGODB_DB: "srsit-smoke",
  LOG_LEVEL: process.env.SMOKE_LOG_LEVEL ?? "error",
  SITE_URL: `http://127.0.0.1:${sitePort}`,
  REVALIDATE_SECRET: secret,
  ADMIN_EMAIL: adminEmail,
  ADMIN_PASSWORD: adminPassword,
  ADMIN_NAME: "Smoke Admin",
  JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
  JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
  CORS_ORIGINS: "http://localhost:3000",
});

const { createApp } = await import("../app.js");
const { connectDb, disconnectDb } = await import("../db.js");
const { upsertAdminFromEnv } = await import("../lib/bootstrap.js");
const { flushRevalidation } = await import("../lib/revalidate.js");
const { SessionModel } = await import("../models/session.js");
const { env } = await import("../config/env.js");
const { cloudinaryFolder, destroyAsset, getCloudinary, isCloudinaryConfigured } = await import("../modules/media/cloudinary.js");
const { COLLECTION_KEYS, ENQUIRY_STATUSES } = await import("../types.js");

// ── Email: the run never talks to a real SMTP server ─────────────────────────
// Email starts switched off whatever server/.env says; the "Email
// notifications" section switches configurations itself.
const mailer = await import("../lib/mailer.js");
const smokeMail = {
  host: "smtp.smoke.invalid",
  port: 587,
  secure: false,
  from: "SRS IT Smoke <no-reply@smoke.example>",
  transport: "json" as const,
  adminUrl: "https://admin.smoke.example",
};
mailer.configureMailer({ ...smokeMail, host: undefined });

// ── Harness ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are asserted structurally
type Json = any;
type Reply = { status: number; headers: Headers; body: Json; text: string };

let passed = 0;
const failures: string[] = [];
const skipped: string[] = [];

function check(name: string, condition: unknown, detail?: unknown): boolean {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
    return true;
  }
  const extra = detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`.slice(0, 600);
  failures.push(`${name}${extra}`);
  console.log(`  FAIL  ${name}${extra}`);
  return false;
}

async function section(name: string, run: () => Promise<void>): Promise<void> {
  console.log(`\n${name}`);
  try {
    await run();
  } catch (error) {
    check(`${name}: completed without throwing`, false, error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = header.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((attribute) => /^\s*expires=Thu, 01 Jan 1970/i.test(attribute) || /^\s*max-age=0\b/i.test(attribute));
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

let baseUrl = "";

async function call(jar: CookieJar | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const isForm = body instanceof FormData;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}),
      ...(jar ? { cookie: jar.header() } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  jar?.absorb(response);
  const text = await response.text();
  let parsed: Json = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (CSV, empty 304)
  }
  return { status: response.status, headers: response.headers, body: parsed, text };
}

/** Waits for a revalidation webhook received after `since` and checks it. */
async function expectWebhook(name: string, since: number): Promise<void> {
  const deadline = Date.now() + 4000;
  let hook: Webhook | undefined;
  while (Date.now() < deadline && !(hook = webhooks.find((entry) => entry.at >= since))) await sleep(50);
  check(`${name}: revalidation webhook received`, hook, `${webhooks.length} webhooks so far`);
  if (!hook) return;
  check(`${name}: webhook carries the secret`, hook.secret === secret);
  const tags = (hook.body as { tags?: unknown })?.tags;
  check(`${name}: webhook body is {"tags":["cms"]}`, Array.isArray(tags) && tags.includes("cms"), hook.body);
}

/** Minimal valid PNG (RGB gradient), so uploads need no fixture files. */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = Math.round((x / width) * 255);
      row[2 + x * 3] = Math.round((y / height) * 255);
      row[3 + x * 3] = 160;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngForm(name: string, png: Buffer, fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(png)], { type: "image/png" }), name);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const image = { url: "/assets/AWS.webp", alt: "AWS", width: 800, height: 600 };

/** Smallest valid create payload per collection, and a field to patch. */
const fixtures: Record<(typeof COLLECTION_KEYS)[number], { create: Record<string, unknown>; patch: Record<string, unknown> }> = {
  solutions: { create: { title: "Smoke Solution", category: "Development", image }, patch: { tagline: "Patched" } },
  industries: { create: { title: "Smoke Industry", image }, patch: { intro: "Patched" } },
  technologies: { create: { title: "Smoke Tech", category: "Frontend", logo: image }, patch: { description: "Patched" } },
  projects: { create: { title: "Smoke Project", image }, patch: { label: "Patched" } },
  articles: { create: { title: "Smoke Article", category: "News", image }, patch: { read: "3 min read" } },
  jobs: { create: { title: "Smoke Job", department: "Engineering" }, patch: { experience: "2+ years" } },
  team: { create: { name: "Smoke Person", photo: image }, patch: { role: "Engineer" } },
  clients: { create: { name: "Smoke Client", logo: image }, patch: { url: "https://example.com" } },
  faqs: { create: { question: "Smoke question?", answer: "Smoke answer." }, patch: { answer: "Patched." } },
  pages: { create: { title: "Smoke Page" }, patch: { eyebrow: "Patched" } },
  redirects: { create: { from: "/smoke-old/", to: "/smoke-new" }, patch: { permanent: false } },
};

// ── Run ──────────────────────────────────────────────────────────────────────

const app = createApp();
const api = createServer(app);
const uploadedPublicIds = new Set<string>();
const cloudFolder = cloudinaryFolder(`smoke-${runId}`);
let rootFolderExisted = true;
let exitCode = 1;

try {
  await connectDb();
  await upsertAdminFromEnv();
  baseUrl = `http://127.0.0.1:${await listen(api)}`;
  console.log(`CMS API smoke test on ${baseUrl} (fake site on :${sitePort}, in-memory MongoDB)`);

  const admin = new CookieJar();
  const published: Record<string, Json> = {};
  let draftSolution: Json;

  await section("Health", async () => {
    const r = await call(null, "GET", "/api/health");
    check("GET /api/health → 200 {ok:true, db:connected}", r.status === 200 && r.body.ok === true && r.body.db === "connected", r.body);
  });

  await section("Auth", async () => {
    let r = await call(admin, "POST", "/api/auth/login", { email: adminEmail, password: "definitely-wrong-1" });
    check("wrong password → 401", r.status === 401, r.body);
    r = await call(admin, "POST", "/api/auth/login", { email: adminEmail, password: adminPassword });
    check("login → 200 {user}", r.status === 200 && r.body.user?.role === "admin" && !("passwordHash" in r.body.user), r.body);
    const cookies = r.headers.getSetCookie().join(" | ");
    check("srs_at + srs_rt cookies are HttpOnly, SameSite=Lax", /srs_at=[^|]*HttpOnly/i.test(cookies) && /srs_rt=[^|]*HttpOnly/i.test(cookies) && /SameSite=Lax/i.test(cookies));
    r = await call(admin, "GET", "/api/auth/me");
    check("GET /me → current user", r.status === 200 && r.body.user?.email === adminEmail, r.body);
    r = await call(null, "GET", "/api/auth/me");
    check("GET /me without cookies → 401", r.status === 401);
    r = await call(admin, "GET", "/api/admin/dashboard", undefined);
    check("admin responses are private, no-store", r.headers.get("cache-control") === "private, no-store");
  });

  await section("Refresh rotation and reuse detection", async () => {
    const first = admin.get("srs_rt");
    let r = await call(admin, "POST", "/api/auth/refresh");
    check("refresh → 200 and rotates srs_rt", r.status === 200 && Boolean(admin.get("srs_rt")) && admin.get("srs_rt") !== first, r.body);

    // A second login of the same user plays the "stolen token" scenario.
    const victim = new CookieJar();
    await call(victim, "POST", "/api/auth/login", { email: adminEmail, password: adminPassword });
    const stolen = victim.get("srs_rt") ?? "";
    r = await call(victim, "POST", "/api/auth/refresh");
    check("second session refreshes", r.status === 200);
    const replay = new CookieJar();
    replay.set("srs_rt", stolen);
    r = await call(replay, "POST", "/api/auth/refresh");
    check("replay inside the grace window → 200 without a new refresh token", r.status === 200 && replay.get("srs_rt") === stolen, r.body);

    // Move rotations outside the 15 s grace window instead of waiting.
    await SessionModel.updateMany({ rotatedAt: { $ne: null } }, { $set: { rotatedAt: new Date(Date.now() - 60_000) } });
    r = await call(replay, "POST", "/api/auth/refresh");
    check("replay after the grace window → 401 refresh_reused", r.status === 401 && r.body?.error?.code === "refresh_reused", r.body);
    r = await call(victim, "GET", "/api/auth/me");
    check("whole session family revoked (successor access token rejected)", r.status === 401, r.body);
    r = await call(victim, "POST", "/api/auth/refresh");
    check("whole session family revoked (successor refresh token rejected)", r.status === 401);
    r = await call(admin, "GET", "/api/auth/me");
    check("other logins are unaffected", r.status === 200);
  });

  await section("Content CRUD (every collection)", async () => {
    for (const key of COLLECTION_KEYS) {
      const fixture = fixtures[key];
      let r = await call(admin, "POST", `/api/admin/${key}`, fixture.create);
      if (!check(`${key}: create → 201`, r.status === 201 && typeof r.body?._id === "string", r.body)) continue;
      const id: string = r.body._id;
      r = await call(admin, "GET", `/api/admin/${key}/${id}`);
      check(`${key}: get → 200`, r.status === 200 && r.body._id === id);
      r = await call(admin, "PATCH", `/api/admin/${key}/${id}`, { ...fixture.patch, status: "published" });
      const [field, value] = Object.entries(fixture.patch)[0]!;
      check(`${key}: patch → 200 and published`, r.status === 200 && r.body.status === "published" && r.body[field] === value, r.body);
      published[key] = r.body;
      r = await call(admin, "GET", `/api/admin/${key}?limit=50`);
      check(`${key}: list → Paginated with the item`, r.status === 200 && r.body.items?.some((item: Json) => item._id === id) && r.body.page === 1, r.body);
      r = await call(admin, "POST", `/api/admin/${key}/${id}/duplicate`);
      check(`${key}: duplicate → 201 draft copy`, r.status === 201 && r.body.status === "draft" && r.body._id !== id, r.body);
      const copyId: string | undefined = r.body?._id;
      if (copyId) {
        r = await call(admin, "DELETE", `/api/admin/${key}/${copyId}`);
        check(`${key}: delete → {ok:true}`, r.status === 200 && r.body.ok === true);
        r = await call(admin, "GET", `/api/admin/${key}/${copyId}`);
        check(`${key}: deleted item → 404`, r.status === 404);
      }
    }
    check("redirect source normalised", published.redirects?.from === "/smoke-old", published.redirects);
    check("solution slug generated from title", published.solutions?.slug === "smoke-solution", published.solutions?.slug);
  });

  await section("Content rules: conflicts, validation, reorder, bulk", async () => {
    let r = await call(admin, "POST", "/api/admin/solutions", { ...fixtures.solutions.create, slug: "smoke-solution" });
    check("explicit duplicate slug → 409 conflict", r.status === 409 && r.body?.error?.code === "conflict", r.body);
    r = await call(admin, "POST", "/api/admin/solutions", { title: "", category: "Nope" });
    check("invalid payload → 422 with fieldErrors", r.status === 422 && r.body?.error?.code === "validation_error" && r.body.error.details?.fieldErrors?.category, r.body);
    r = await call(admin, "PATCH", `/api/admin/solutions/${published.solutions._id}`, { slug: "Not A Slug!" });
    check("invalid patch → 422", r.status === 422);
    r = await call(admin, "GET", "/api/admin/solutions/not-an-id");
    check("malformed id → 404", r.status === 404);
    r = await call(admin, "GET", "/api/admin/not-a-collection");
    check("unknown collection → 404", r.status === 404);

    const ids: string[] = [];
    for (const title of ["Smoke Order A", "Smoke Order B", "Smoke Order C"]) {
      r = await call(admin, "POST", "/api/admin/solutions", { ...fixtures.solutions.create, title });
      ids.push(r.body._id);
    }
    const reordered = [...ids].reverse();
    r = await call(admin, "POST", "/api/admin/solutions/reorder", { ids: [published.solutions._id, ...reordered] });
    check("reorder → {ok, updated}", r.status === 200 && r.body.ok === true && typeof r.body.updated === "number", r.body);
    r = await call(admin, "GET", "/api/admin/solutions?sort=order&limit=50");
    const titles = r.body.items.map((item: Json) => item.title);
    check("reorder applied (order = index)", titles.join("|") === ["Smoke Solution", "Smoke Order C", "Smoke Order B", "Smoke Order A"].join("|"), titles);

    r = await call(admin, "POST", "/api/admin/solutions/bulk", { action: "publish", ids });
    check("bulk publish → count 3", r.status === 200 && r.body.count === 3, r.body);
    r = await call(admin, "POST", "/api/admin/solutions/bulk", { action: "draft", ids: [ids[0]] });
    check("bulk draft → count 1", r.status === 200 && r.body.count === 1, r.body);
    r = await call(admin, "POST", "/api/admin/solutions/bulk", { action: "delete", ids: [ids[1], ids[2]] });
    check("bulk delete → count 2", r.status === 200 && r.body.count === 2, r.body);
    r = await call(admin, "GET", `/api/admin/solutions?status=draft`);
    draftSolution = r.body.items?.find((item: Json) => item._id === ids[0]);
    check("status filter returns the draft", Boolean(draftSolution) && r.body.total === 1, r.body);
  });

  await section("Settings", async () => {
    let r = await call(admin, "GET", "/api/admin/settings/site");
    check("GET site → defaults before first save", r.status === 200 && typeof r.body.company === "object", r.body);
    const siteSettings = r.body;
    siteSettings.company.name = "SRS IT Smoke";
    siteSettings.company.email = "smoke@example.com";
    const since = Date.now();
    r = await call(admin, "PUT", "/api/admin/settings/site", siteSettings);
    check("PUT site → saved object", r.status === 200 && r.body.company.name === "SRS IT Smoke", r.body);
    await expectWebhook("settings write", since);
    r = await call(admin, "PUT", "/api/admin/settings/site", { ...siteSettings, company: { ...siteSettings.company, email: "not-an-email" } });
    check("PUT site invalid → 422 with dotted issue path", r.status === 422 && r.body.error.details?.issues?.some((issue: Json) => issue.path === "company.email"), r.body);
    r = await call(admin, "GET", "/api/admin/settings/home");
    check("GET home → object", r.status === 200 && typeof r.body.hero === "object");
    const home = r.body;
    home.hero.title = "Smoke hero";
    home.stats = [{ value: "10+", label: "Years" }];
    r = await call(admin, "PUT", "/api/admin/settings/home", home);
    check("PUT home → saved", r.status === 200 && r.body.hero.title === "Smoke hero" && r.body.stats.length === 1, r.body);
    r = await call(admin, "GET", "/api/admin/settings/nope");
    check("unknown settings key → 404", r.status === 404);
  });

  await section("Public read API", async () => {
    let r = await call(null, "GET", "/api/public/bundle");
    const etag = r.headers.get("etag");
    check("bundle → 200 with ETag and contract Cache-Control", r.status === 200 && Boolean(etag) && r.headers.get("cache-control") === "public, max-age=60, stale-while-revalidate=600");
    const bundle = r.body;
    check("bundle has every collection + site + home + version", COLLECTION_KEYS.every((key) => Array.isArray(bundle[key])) && bundle.site && bundle.home && typeof bundle.version === "string");
    check("bundle holds only published documents", COLLECTION_KEYS.every((key) => bundle[key].every((doc: Json) => doc.status === "published")));
    check("bundle excludes the draft solution", !bundle.solutions.some((doc: Json) => doc._id === draftSolution?._id));
    check("bundle includes every published fixture", COLLECTION_KEYS.every((key) => bundle[key].some((doc: Json) => doc._id === published[key]?._id)));
    check("bundle carries saved settings", bundle.site.company.name === "SRS IT Smoke" && bundle.home.hero.title === "Smoke hero");
    r = await call(null, "GET", "/api/public/bundle", undefined, { "if-none-match": etag ?? "" });
    check("If-None-Match → 304", r.status === 304, r.status);
    await call(admin, "PATCH", `/api/admin/faqs/${published.faqs._id}`, { answer: "Changed again." });
    r = await call(null, "GET", "/api/public/bundle", undefined, { "if-none-match": etag ?? "" });
    check("a write invalidates the bundle (new ETag)", r.status === 200 && r.headers.get("etag") !== etag, r.status);
    r = await call(null, "GET", "/api/public/solutions/smoke-solution");
    check("GET /public/solutions/:slug", r.status === 200 && r.body.slug === "smoke-solution");
    r = await call(null, "GET", `/api/public/solutions/${draftSolution?.slug ?? "missing"}`);
    check("draft slug is hidden → 404", r.status === 404);
    r = await call(null, "GET", "/api/public/faqs");
    check("GET /public/faqs → array", r.status === 200 && Array.isArray(r.body) && r.body.length === 1);
    r = await call(null, "GET", "/api/public/settings/site");
    check("GET /public/settings/site", r.status === 200 && r.body.company.name === "SRS IT Smoke");
  });

  await section("Enquiries", async () => {
    let r = await call(null, "POST", "/api/public/enquiries", { name: "Bot", email: "bot@example.com", message: "Buy now", website: "http://spam.example" });
    check("honeypot → 201 {ok:true}", r.status === 201 && r.body.ok === true, r.body);
    r = await call(null, "POST", "/api/public/enquiries", {
      name: 'Alice "Smoke"',
      email: "alice@example.com",
      company: "Acme",
      service: "Web Development",
      message: "=HYPERLINK(\"http://x\") we need a website",
    });
    check("valid enquiry → 201", r.status === 201, r.body);
    r = await call(null, "POST", "/api/public/enquiries", { name: "", email: "nope" });
    check("invalid enquiry → 422", r.status === 422);
    r = await call(admin, "GET", "/api/admin/enquiries");
    check("admin list holds only the real enquiry (honeypot not stored)", r.status === 200 && r.body.total === 1, r.body);
    const id: string = r.body.items?.[0]?._id;
    r = await call(admin, "PATCH", `/api/admin/enquiries/${id}`, { status: "in-progress" });
    check("status change", r.status === 200 && r.body.status === "in-progress", r.body);
    r = await call(admin, "POST", `/api/admin/enquiries/${id}/notes`, { body: "Called back" });
    check("add note → 201", r.status === 201 && r.body.notes?.length === 1, r.body);
    r = await call(admin, "GET", "/api/admin/enquiries/export.csv");
    check("CSV export", r.status === 200 && /text\/csv/.test(r.headers.get("content-type") ?? "") && r.text.includes('"Alice ""Smoke"""'), r.text.slice(0, 200));
    check("CSV neutralises formulas", r.text.includes("'=HYPERLINK"), r.text.slice(0, 300));
  });

  await section("Users and roles", async () => {
    const me = (await call(admin, "GET", "/api/auth/me")).body.user;
    let r = await call(admin, "PATCH", `/api/admin/users/${me._id}`, { role: "editor" });
    check("sole admin cannot demote themself → 409", r.status === 409, r.body);
    r = await call(admin, "PATCH", `/api/admin/users/${me._id}`, { active: false });
    check("sole admin cannot deactivate themself → 409", r.status === 409, r.body);
    r = await call(admin, "DELETE", `/api/admin/users/${me._id}`);
    check("sole admin cannot delete themself → 409", r.status === 409, r.body);

    r = await call(admin, "POST", "/api/admin/users", { name: "Second Admin", email: `second-${runId}@example.com`, role: "admin", password: "second-admin-pass-1" });
    check("create second admin", r.status === 201 && r.body.role === "admin", r.body);
    const secondId: string = r.body._id;
    r = await call(admin, "PATCH", `/api/admin/users/${secondId}`, { role: "editor" });
    check("demoting another admin is allowed while one remains", r.status === 200 && r.body.role === "editor", r.body);
    r = await call(admin, "DELETE", `/api/admin/users/${secondId}`);
    check("delete user", r.status === 200);

    r = await call(admin, "POST", "/api/admin/users", { name: "Viewer", email: `viewer-${runId}@example.com`, role: "viewer", password: "short" });
    check("short password → 422", r.status === 422);
    r = await call(admin, "POST", "/api/admin/users", { name: "Viewer", email: `viewer-${runId}@example.com`, role: "viewer", password: "viewer-pass-123" });
    check("create viewer", r.status === 201);
    r = await call(admin, "POST", "/api/admin/users", { name: "Viewer 2", email: `viewer-${runId}@example.com`, role: "viewer", password: "viewer-pass-123" });
    check("duplicate email → 409", r.status === 409);
    r = await call(admin, "POST", "/api/admin/users", { name: "Editor", email: `editor-${runId}@example.com`, role: "editor", password: "editor-pass-123" });
    check("create editor", r.status === 201);

    const viewer = new CookieJar();
    await call(viewer, "POST", "/api/auth/login", { email: `viewer-${runId}@example.com`, password: "viewer-pass-123" });
    r = await call(viewer, "GET", "/api/admin/solutions");
    check("viewer can read content", r.status === 200);
    r = await call(viewer, "POST", "/api/admin/solutions", fixtures.solutions.create);
    check("viewer cannot create content → 403", r.status === 403);
    r = await call(viewer, "PATCH", `/api/admin/solutions/${published.solutions._id}`, { tagline: "x" });
    check("viewer cannot update content → 403", r.status === 403);
    r = await call(viewer, "PUT", "/api/admin/settings/site", {});
    check("viewer cannot write settings → 403", r.status === 403);
    r = await call(viewer, "POST", "/api/admin/media", pngForm("viewer.png", makePng(4, 4)));
    check("viewer cannot upload media → 403", r.status === 403);
    r = await call(viewer, "GET", "/api/admin/media");
    check("viewer can browse media", r.status === 200);
    r = await call(viewer, "GET", "/api/admin/users");
    check("viewer cannot manage users → 403", r.status === 403);

    const editor = new CookieJar();
    await call(editor, "POST", "/api/auth/login", { email: `editor-${runId}@example.com`, password: "editor-pass-123" });
    r = await call(editor, "PATCH", `/api/admin/faqs/${published.faqs._id}`, { answer: "Edited by editor." });
    check("editor can write content", r.status === 200);
    r = await call(editor, "GET", "/api/admin/users");
    check("editor cannot manage users → 403", r.status === 403);
  });

  await section("Dashboard, activity, manual revalidation", async () => {
    let r = await call(admin, "GET", "/api/admin/dashboard");
    const stats = r.body;
    const countKeys = [...COLLECTION_KEYS, "media", "enquiries", "users"];
    check("dashboard → 200", r.status === 200);
    check("dashboard counts cover every collection, media, enquiries and users", countKeys.every((key) => typeof stats.counts?.[key] === "number"), stats.counts);
    check("dashboard drafts is a number", typeof stats.drafts === "number");
    check("dashboard enquiries.byStatus has every status", ENQUIRY_STATUSES.every((status) => typeof stats.enquiries?.byStatus?.[status] === "number"), stats.enquiries?.byStatus);
    check("dashboard enquiries.daily covers 30 days", Array.isArray(stats.enquiries?.daily) && stats.enquiries.daily.length === 30);
    check("dashboard enquiries.recent is a list", Array.isArray(stats.enquiries?.recent) && stats.enquiries.recent.length === 1);
    check("dashboard media {count, bytes}", typeof stats.media?.count === "number" && typeof stats.media?.bytes === "number");
    check("dashboard activity feed", Array.isArray(stats.activity) && stats.activity.length > 0);
    r = await call(admin, "GET", "/api/admin/activity?entity=solutions&limit=5");
    check("activity list filtered by entity", r.status === 200 && r.body.items.length === 5 && r.body.items.every((item: Json) => item.entity === "solutions"), r.body);
    const since = Date.now();
    r = await call(admin, "POST", "/api/admin/revalidate");
    check("manual revalidate → {ok, revalidated:true}", r.status === 200 && r.body.ok === true && r.body.revalidated === true, r.body);
    await expectWebhook("manual revalidate", since);
  });

  await section("Media library (Cloudinary)", async () => {
    if (!isCloudinaryConfigured()) {
      const r = await call(admin, "POST", "/api/admin/media", pngForm("x.png", makePng(4, 4)));
      check("upload without Cloudinary credentials → 503", r.status === 503, r.body);
      skipped.push("Cloudinary upload/patch/usage/delete (CLOUDINARY_* not configured)");
      return;
    }

    const sdk = getCloudinary();
    const roots = (await sdk.api.root_folders()) as { folders: { path: string }[] };
    rootFolderExisted = roots.folders.some((folder) => folder.path === env.CLOUDINARY_FOLDER);
    const folder = `smoke-${runId}`;

    let r = await call(admin, "POST", "/api/admin/media", (() => {
      const form = new FormData();
      form.append("files", new Blob(["not an image"], { type: "text/plain" }), "notes.txt");
      return form;
    })());
    check("non-image upload → 415", r.status === 415, r.body);
    r = await call(admin, "POST", "/api/admin/media", new FormData());
    check("upload without files → 422", r.status === 422, r.body);
    r = await call(admin, "POST", "/api/admin/media", pngForm("huge.png", Buffer.alloc(10 * 1024 * 1024 + 1)));
    check("file over 10 MB (Cloudinary free-plan cap) → 413 with a friendly message", r.status === 413 && r.body?.error?.code === "payload_too_large" && /10 MB/.test(r.body?.error?.message ?? ""), r.body);

    const since = Date.now();
    r = await call(admin, "POST", "/api/admin/media", pngForm("smoke-gradient.png", makePng(48, 32), { folder, alt: "Smoke gradient", tags: "smoke, Test" }));
    const media = Array.isArray(r.body) ? r.body[0] : undefined;
    if (media?.publicId) uploadedPublicIds.add(media.publicId);
    if (!check("upload PNG → 201 Media[]", r.status === 201 && Array.isArray(r.body) && r.body.length === 1, r.body)) return;
    check("media dimensions, format and bytes recorded", media.width === 48 && media.height === 32 && media.format === "png" && media.bytes > 0, media);
    check("media stored under the Cloudinary folder", media.publicId.startsWith(`${cloudFolder}/`) && media.url.startsWith("https://res.cloudinary.com/"), media.publicId);
    check("media metadata (folder, alt, title, tags, uploadedBy)", media.folder === folder && media.alt === "Smoke gradient" && media.title === "Smoke gradient" && media.tags.join() === "smoke,test" && typeof media.uploadedBy === "string", media);
    check("blurDataURL generated", typeof media.blurDataURL === "string" && media.blurDataURL.startsWith("data:image/"), media.blurDataURL?.slice(0, 40));
    await expectWebhook("media upload", since);
    const delivered = await fetch(media.url);
    check("uploaded asset is publicly deliverable", delivered.ok, delivered.status);

    r = await call(admin, "GET", `/api/admin/media?folder=${folder}`);
    check("list by folder", r.status === 200 && r.body.total === 1 && r.body.items[0]._id === media._id, r.body);
    r = await call(admin, "GET", "/api/admin/media?q=gradient");
    check("list by search", r.status === 200 && r.body.items.some((item: Json) => item._id === media._id));
    r = await call(admin, "GET", "/api/admin/media/folders");
    check("folders include the upload folder and library", r.status === 200 && r.body.includes(folder) && r.body.includes("library"), r.body);
    r = await call(admin, "GET", `/api/admin/media/${media._id}`);
    check("get media", r.status === 200 && r.body.publicId === media.publicId);

    const patchSince = Date.now();
    r = await call(admin, "PATCH", `/api/admin/media/${media._id}`, { alt: "Updated alt", title: "Renamed", tags: ["Smoke", "smoke", "edited"], folder: `${folder}/sub` });
    check("patch metadata", r.status === 200 && r.body.alt === "Updated alt" && r.body.title === "Renamed" && r.body.tags.join() === "smoke,edited" && r.body.folder === `${folder}/sub`, r.body);
    await expectWebhook("media patch", patchSince);
    r = await call(admin, "PATCH", `/api/admin/media/${media._id}`, { folder: "../etc" });
    check("invalid folder → 422", r.status === 422);
    r = await call(admin, "GET", `/api/admin/media?folder=${folder}`);
    check("folder filter includes sub-folders", r.status === 200 && r.body.total === 1);

    r = await call(admin, "GET", `/api/admin/media/${media._id}/usage`);
    check("usage of an unused image → []", r.status === 200 && Array.isArray(r.body) && r.body.length === 0, r.body);

    const ref = { url: media.url, publicId: media.publicId, mediaId: media._id, width: media.width, height: media.height, alt: "Used" };
    r = await call(admin, "PATCH", `/api/admin/solutions/${published.solutions._id}`, { image: ref });
    check("reference the image from a solution", r.status === 200 && r.body.image.mediaId === media._id);
    const home = (await call(admin, "GET", "/api/admin/settings/home")).body;
    home.about.image = { ...ref, mediaId: undefined };
    r = await call(admin, "PUT", "/api/admin/settings/home", home);
    check("reference the image from homepage settings (publicId only)", r.status === 200);
    r = await call(admin, "GET", `/api/admin/media/${media._id}/usage`);
    const usage: Json[] = r.body ?? [];
    check("usage finds the solution", usage.some((entry) => entry.collection === "solutions" && entry.id === published.solutions._id && entry.label === "Smoke Solution" && entry.paths.includes("image")), usage);
    check("usage finds the homepage settings", usage.some((entry) => entry.collection === "settings" && entry.id === "home" && entry.paths.includes("about.image")), usage);

    r = await call(admin, "DELETE", `/api/admin/media/${media._id}`);
    check("delete referenced image → 409 with usage", r.status === 409 && r.body.error?.details?.usage?.length === 2, r.body);
    const deleteSince = Date.now();
    r = await call(admin, "DELETE", `/api/admin/media/${media._id}?force=1`);
    check("force delete → 200", r.status === 200 && r.body.ok === true, r.body);
    if (r.status === 200) uploadedPublicIds.delete(media.publicId);
    await expectWebhook("media delete", deleteSince);
    r = await call(admin, "GET", `/api/admin/media/${media._id}`);
    check("deleted media → 404", r.status === 404);
    const gone = await sdk.api.resource(media.publicId).then(
      () => false,
      (error: { error?: { http_code?: number } }) => error?.error?.http_code === 404,
    );
    check("asset removed from Cloudinary", gone);
  });

  // ── Media: signed direct uploads (sign → browser-style POST to Cloudinary → register) ──
  await section("Media direct uploads (signed, browser → Cloudinary)", async () => {
    const { MAX_UPLOAD_BYTES } = await import("../modules/media/media.schemas.js");
    if (!isCloudinaryConfigured()) {
      const r = await call(admin, "POST", "/api/admin/media/sign", {});
      check("sign without Cloudinary credentials → 503", r.status === 503, r.body);
      skipped.push("Cloudinary direct upload round trip (CLOUDINARY_* not configured)");
      return;
    }

    const sdk = getCloudinary();
    const folder = `smoke-${runId}`;
    const viewer = new CookieJar();
    await call(viewer, "POST", "/api/auth/login", { email: `viewer-${runId}@example.com`, password: "viewer-pass-123" });

    let r = await call(viewer, "POST", "/api/admin/media/sign", { folder });
    check("viewer cannot sign uploads → 403", r.status === 403, r.body);
    r = await call(admin, "POST", "/api/admin/media/sign", { folder: "../etc" });
    check("sign with an invalid folder → 422", r.status === 422, r.body?.error);
    r = await call(admin, "POST", "/api/admin/media/sign", {});
    check("sign without a folder → <root>/library", r.status === 200 && r.body.folder === `${env.CLOUDINARY_FOLDER}/library`, r.body?.folder ?? r.body?.error);

    // Extra client params must never reach the signature.
    r = await call(admin, "POST", "/api/admin/media/sign", { folder: ` ${folder.toUpperCase()} `, public_id: "evil", overwrite: "true", eager: "w_10" });
    const signed: Json = r.body;
    const signedKeys = Object.keys(signed?.fields ?? {}).sort().join(",");
    const signatureOk = r.status === 200 && /^[a-f0-9]{40,64}$/.test(signed.signature) && typeof signed.timestamp === "number" && Boolean(signed.apiKey);
    if (!check("sign → 200 with a signature", signatureOk && signed.cloudName === env.CLOUDINARY_CLOUD_NAME, r.body?.error ?? r.status)) return;
    check("signed folder is sanitised and forced under the media root", signed.folder === cloudFolder && signed.fields.folder === cloudFolder, signed.folder);
    check(
      "signed parameter set is fixed server-side (client extras ignored)",
      signedKeys === "allowed_formats,api_key,folder,overwrite,signature,timestamp,unique_filename,use_filename" &&
        signed.fields.overwrite === "false" &&
        signed.fields.use_filename === "true" &&
        signed.fields.unique_filename === "true",
      signedKeys,
    );
    check(
      "sign advertises the upload URL, the 10 MB cap and the image formats",
      signed.uploadUrl === `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload` &&
        signed.maxBytes === MAX_UPLOAD_BYTES &&
        MAX_UPLOAD_BYTES === 10 * 1024 * 1024 &&
        ["jpg", "png", "webp", "avif", "gif", "svg"].every((format) => signed.allowedFormats?.includes(format)),
      { uploadUrl: signed.uploadUrl, maxBytes: signed.maxBytes, allowedFormats: signed.allowedFormats },
    );

    /** Posts like the admin's XHR does: the signed fields verbatim plus `file`. */
    const postToCloudinary = async (fields: Record<string, string>, png: Buffer, name: string) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), name);
      const response = await fetch(signed.uploadUrl, { method: "POST", body: form });
      const body: Json = await response.json().catch(() => null);
      if (typeof body?.public_id === "string") uploadedPublicIds.add(body.public_id);
      return { status: response.status, body };
    };

    let cld = await postToCloudinary({ ...signed.fields, public_id: `smoke-escape-${runId}` }, makePng(8, 8), "escape.png");
    check("Cloudinary rejects a parameter the API did not sign → 401", cld.status === 401, cld.body);

    cld = await postToCloudinary(signed.fields, makePng(40, 24), "smoke-direct.png");
    const publicId: string = cld.body?.public_id;
    if (!check("POST the file to Cloudinary with the signed fields → 200", cld.status === 200 && typeof publicId === "string", cld.body?.error ?? cld.status)) return;
    check("asset lands in the signed folder with a unique file name", new RegExp(`^${cloudFolder}/smoke-direct_[a-z0-9]+$`).test(publicId), publicId);

    const since = Date.now();
    // Client-sent technical metadata must be ignored (zod strips it; Cloudinary is the source of truth).
    r = await call(admin, "POST", "/api/admin/media/register", {
      publicId,
      alt: "Direct alt",
      filename: "Smoke Direct.png",
      url: "https://evil.example/x.png",
      width: 9999,
      height: 9999,
      bytes: 1,
      format: "gif",
    });
    const media: Json = r.body;
    if (!check("register → 201 Media", r.status === 201 && typeof media?._id === "string" && media.publicId === publicId, r.body)) return;
    check(
      "register reads url, size, dimensions and format from Cloudinary",
      media.width === 40 &&
        media.height === 24 &&
        media.format === "png" &&
        media.bytes > 1 &&
        media.url.startsWith(`https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/`) &&
        media.url.includes(publicId),
      media,
    );
    check("register derives folder, title, alt and uploader", media.folder === folder && media.title === "Smoke Direct" && media.alt === "Direct alt" && typeof media.uploadedBy === "string", media);
    check("register generates blurDataURL", typeof media.blurDataURL === "string" && media.blurDataURL.startsWith("data:image/"), media.blurDataURL?.slice(0, 40));
    await expectWebhook("direct upload register", since);
    r = await call(admin, "GET", "/api/admin/activity?entity=media&limit=5");
    check("register records an upload activity", r.status === 200 && r.body.items?.some((item: Json) => item.action === "upload" && item.entityId === media._id), r.body?.items);

    r = await call(admin, "POST", "/api/admin/media/register", { publicId, alt: "Changed" });
    check("registering again → 200 with the same record (idempotent)", r.status === 200 && r.body?._id === media._id && r.body.alt === "Direct alt", r.body);
    r = await call(admin, "GET", `/api/admin/media?folder=${folder}&limit=50`);
    check("library holds exactly one record for the asset", r.status === 200 && r.body.items.filter((item: Json) => item.publicId === publicId).length === 1, r.body?.total);

    r = await call(admin, "POST", "/api/admin/media/register", { publicId: `elsewhere-${runId}/smoke-direct` });
    check("register a public id outside the media folder → 403", r.status === 403, r.body);
    r = await call(admin, "POST", "/api/admin/media/register", { publicId: `${env.CLOUDINARY_FOLDER}/../elsewhere/smoke-direct` });
    check("register a path-escaping public id → 403", r.status === 403, r.body);
    r = await call(admin, "POST", "/api/admin/media/register", { publicId: `${cloudFolder}/missing-${runId}` });
    check("register an asset that does not exist → 404", r.status === 404, r.body);
    r = await call(admin, "POST", "/api/admin/media/register", {});
    check("register without publicId → 422", r.status === 422, r.body?.error?.code);
    r = await call(viewer, "POST", "/api/admin/media/register", { publicId });
    check("viewer cannot register → 403", r.status === 403, r.body);

    r = await call(admin, "DELETE", `/api/admin/media/${media._id}`);
    check("delete the direct upload via DELETE /media/:id → 200", r.status === 200 && r.body.ok === true, r.body);
    const gone = await sdk.api.resource(publicId).then(
      () => false,
      (error: { error?: { http_code?: number } }) => error?.error?.http_code === 404,
    );
    if (gone) uploadedPublicIds.delete(publicId);
    check("direct upload removed from Cloudinary", gone);
    r = await call(admin, "POST", "/api/admin/media/register", { publicId });
    check("registering a deleted asset → 404 (verified against Cloudinary)", r.status === 404, r.body);
  });

  // ── Email notifications (enquiry emails, status and test endpoints) ─────────
  await section("Email notifications", async () => {
    const { createServer: createTcpServer } = await import("node:net");
    const { enquiryLimiter } = await import("../middleware/rate-limit.js");
    const { logger } = await import("../lib/logger.js");
    const outbox: { result: Json; mail: Json }[] = [];
    const stopListening = mailer.onMailSettled((result, mail) => outbox.push({ result, mail }));
    // A fake SMTP server that refuses service and echoes the credentials, to prove errors are redacted.
    const smtp = createTcpServer((socket) => {
      socket.on("error", () => undefined);
      socket.end("554 smoke-user smoke-secret-pass refuses service\r\n");
    });
    const smtpPort = await new Promise<number>((resolve, reject) => {
      smtp.once("error", reject);
      smtp.listen(0, "127.0.0.1", () => resolve((smtp.address() as AddressInfo).port));
    });
    const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
      // Expected SMTP failures are logged at error level; keep them out of the smoke output.
      const level = logger.level;
      logger.level = "silent";
      try {
        return await run();
      } finally {
        logger.level = level;
      }
    };
    const viewer = new CookieJar();
    await call(viewer, "POST", "/api/auth/login", { email: `viewer-${runId}@example.com`, password: "viewer-pass-123" });
    const alerts = `alerts-${runId}@example.com`;
    let testCalls = 0;
    const sendTest = (body: unknown) => {
      testCalls += 1;
      return call(admin, "POST", "/api/admin/settings/email/test", body);
    };

    try {
      // Earlier sections used part of the per-IP enquiry allowance (5 per 10 minutes).
      enquiryLimiter.resetKey("127.0.0.1");

      // Email off (SMTP_HOST unset).
      mailer.configureMailer({ ...smokeMail, host: undefined });
      let r = await call(admin, "GET", "/api/admin/settings/email/status");
      check(
        "email off: status → {configured:false, to: ADMIN_EMAIL fallback, issue}",
        r.status === 200 && r.body.configured === false && r.body.to === adminEmail && /SMTP_HOST/.test(r.body.issue) && !("from" in r.body),
        r.body,
      );
      r = await sendTest({});
      check("email off: test → 400 not_configured", r.status === 400 && r.body.error?.code === "not_configured", r.body);
      r = await call(null, "POST", "/api/public/enquiries", { name: "Offline Olive", email: "olive@example.com", message: "Email is switched off for this one." });
      await mailer.flushMail();
      check("email off: enquiry still → 201 and nothing is sent", r.status === 201 && outbox.length === 0, { status: r.status, sent: outbox.length });

      // Email on (MAIL_TRANSPORT=json renders without delivering).
      mailer.configureMailer(smokeMail);
      const site = (await call(admin, "GET", "/api/admin/settings/site")).body;
      r = await call(admin, "PUT", "/api/admin/settings/site", { ...site, notificationEmail: alerts });
      check("save Site settings → notificationEmail", r.status === 200 && r.body.notificationEmail === alerts, r.body?.error);
      r = await call(admin, "GET", "/api/admin/settings/email/status");
      check(
        "email on: status → {configured:true, from, to: notificationEmail}",
        r.status === 200 && r.body.configured === true && r.body.from === smokeMail.from && r.body.to === alerts && !("issue" in r.body),
        r.body,
      );

      r = await call(null, "POST", "/api/public/enquiries", {
        name: "Eve <script>alert(1)</script>\r\nBcc: victim@example.com",
        email: "Eve.Visitor@Example.com",
        phone: "+880 1711-000000",
        service: "Web Development",
        message: "Line one\r\nLine <b>two</b> & more",
        source: "/contact",
      });
      check("enquiry → 201", r.status === 201, r.body);
      await mailer.flushMail();
      const list = await call(admin, "GET", "/api/admin/enquiries?q=eve.visitor");
      const enquiryId: string = list.body?.items?.[0]?._id ?? "missing";
      check("enquiry → exactly one email", outbox.length === 1, outbox.map((entry) => entry.mail.subject));
      const out = outbox[0];
      const rendered: Json = typeof out?.result?.message === "string" ? JSON.parse(out.result.message) : null;
      if (check("email rendered by the JSON transport", out?.result?.sent === true && rendered, out?.result)) {
        check("To = Site settings notificationEmail, nobody else", rendered.to?.length === 1 && rendered.to[0].address === alerts && !rendered.cc && !rendered.bcc, rendered.to);
        check("From = MAIL_FROM", rendered.from?.address === "no-reply@smoke.example" && rendered.from?.name === "SRS IT Smoke", rendered.from);
        check(
          "Reply-To = the visitor, display name on one line",
          rendered.replyTo?.length === 1 && rendered.replyTo[0].address === "eve.visitor@example.com" && !/[\r\n]/.test(rendered.replyTo[0].name),
          rendered.replyTo,
        );
        check("subject: one line with name and service", rendered.subject === "New enquiry from Eve <script>alert(1)</script> Bcc: victim@example.com — Web Development", rendered.subject);
        check("no injected headers", Object.keys(rendered.headers ?? {}).length === 0, rendered.headers);
        check(
          "HTML escapes every visitor value",
          !rendered.html.includes("<script") &&
            rendered.html.includes("Eve &lt;script&gt;alert(1)&lt;/script&gt; Bcc: victim@example.com") &&
            rendered.html.includes("Line one<br>Line &lt;b&gt;two&lt;/b&gt; &amp; more"),
          rendered.html.slice(0, 300),
        );
        check("HTML uses the SRS IT orange accent", rendered.html.includes("#ff801b"));
        check("HTML links to the enquiry in the admin", rendered.html.includes(`https://admin.smoke.example/admin/enquiries?open=${enquiryId}`), enquiryId);
        check(
          "plain-text alternative keeps line breaks, the admin link and Dhaka time",
          rendered.text.includes("Line one\nLine <b>two</b> & more") && rendered.text.includes(`?open=${enquiryId}`) && rendered.text.includes("(Dhaka time)"),
          rendered.text,
        );
      }

      r = await call(null, "POST", "/api/public/enquiries", { name: "Bot", email: "bot@example.com", message: "Buy now", website: "http://spam.example" });
      await mailer.flushMail();
      check("honeypot → 201 and no email", r.status === 201 && outbox.length === 1, outbox.length);

      r = await sendTest({});
      check("test email → {sent:true, to: notificationEmail}", r.status === 200 && r.body.sent === true && r.body.to === alerts, r.body);
      const testMail = outbox.at(-1);
      check("test email goes to that address", outbox.length === 2 && testMail?.mail.to === alerts && testMail.mail.subject === "Test email from the SRS IT website", testMail?.mail);
      check("nothing was ever sent to a visitor", outbox.every((entry) => entry.mail.to === alerts), outbox.map((entry) => entry.mail.to));
      r = await sendTest({ to: "not-an-email" });
      check("test email to an invalid address → 422", r.status === 422, r.body);
      r = await call(viewer, "GET", "/api/admin/settings/email/status");
      check("viewer cannot read the email status → 403", r.status === 403, r.body);
      r = await call(viewer, "POST", "/api/admin/settings/email/test", {});
      check("viewer cannot send a test email → 403", r.status === 403, r.body);
      r = await call(admin, "GET", "/api/admin/settings/site");
      check("settings documents still resolve next to /email/*", r.status === 200 && r.body.notificationEmail === alerts);

      // SMTP server failing: the public form is unaffected; the test endpoint reports a redacted 502.
      mailer.configureMailer({ ...smokeMail, transport: "smtp", host: "127.0.0.1", port: smtpPort, user: "smoke-user", pass: "smoke-secret-pass" });
      r = await quietly(() => sendTest({}));
      const smtpMessage: string = r.body?.error?.message ?? "";
      check(
        "SMTP failure: test → 502 smtp_error with the server's answer, credentials redacted",
        r.status === 502 && r.body.error?.code === "smtp_error" && smtpMessage.includes("554") && !smtpMessage.includes("smoke-secret-pass") && !smtpMessage.includes("smoke-user"),
        r.body,
      );
      r = await quietly(async () => {
        const reply = await call(null, "POST", "/api/public/enquiries", { name: "Patient Pat", email: "pat@example.com", message: "Sent while SMTP is down." });
        await mailer.flushMail();
        return reply;
      });
      const failed = outbox.at(-1);
      check("SMTP failure: enquiry still → 201", r.status === 201, r.body);
      check("SMTP failure: the send fails softly (logged, never thrown)", failed?.result?.sent === false && failed.result.reason === "send_failed", failed?.result);

      // 5 test emails per 10 minutes per user.
      mailer.configureMailer(smokeMail);
      const statuses: number[] = [];
      while (testCalls < 6) statuses.push((await sendTest({})).status);
      check("test email is rate limited after 5 per user → 429", statuses.at(-1) === 429 && !statuses.slice(0, -1).includes(429), statuses);
    } finally {
      stopListening();
      mailer.configureMailer({ ...smokeMail, host: undefined });
      await new Promise((resolve) => smtp.close(resolve));
    }
  });

  exitCode = failures.length > 0 ? 1 : 0;
} catch (error) {
  failures.push(`smoke run aborted: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  console.error(`\nSmoke run aborted: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await cleanup();
}

async function cleanup(): Promise<void> {
  if (isCloudinaryConfigured()) {
    for (const publicId of uploadedPublicIds) {
      await destroyAsset(publicId).catch((error: unknown) => console.error(`cleanup: could not delete ${publicId}: ${String(error)}`));
    }
    const sdk = getCloudinary();
    const folders = [cloudFolder, ...(rootFolderExisted ? [] : [env.CLOUDINARY_FOLDER])];
    for (const folder of folders) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const outcome = await sdk.api.delete_folder(folder).then(
          () => "deleted",
          (error: { error?: { http_code?: number; message?: string } }) => (error?.error?.http_code === 404 ? "absent" : (error?.error?.message ?? "error")),
        );
        if (outcome === "deleted" || outcome === "absent") break;
        if (attempt === 4) console.error(`cleanup: could not delete Cloudinary folder ${folder}: ${outcome}`);
        await sleep(1000);
      }
    }
  }
  await flushRevalidation().catch(() => undefined);
  api.closeAllConnections();
  site.closeAllConnections();
  await Promise.all([new Promise((resolve) => api.close(resolve)), new Promise((resolve) => site.close(resolve))]);
  await disconnectDb().catch(() => undefined);
}

console.log(`\n${passed} passed, ${failures.length} failed${skipped.length ? `, skipped: ${skipped.join("; ")}` : ""}`);
if (failures.length) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(failures.length ? 1 : exitCode);
