import { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { HttpError, notFound } from "../../lib/errors.js";
import { requireRole } from "../../middleware/auth.js";
import { parseBody } from "../../middleware/validate.js";
import type { SettingsKey } from "../../types.js";
import { emailSchema } from "../auth/auth.schemas.js";
import { emailStatus, sendTestEmail } from "../enquiries/enquiries.notify.js";
import { getSettings, isSettingsKey, saveSettings } from "./settings.service.js";

export const settingsRouter = Router();

function settingsKey(req: Request): SettingsKey {
  const key = req.params.key;
  if (!isSettingsKey(key)) throw notFound(`Unknown settings "${String(key)}"`);
  return key;
}

// ── Email notifications (editors and admins) ─────────────────────────────────
// Registered before "/:key" so these fixed paths are never read as a settings key.

const editorsOnly = requireRole("admin", "editor");

/** 5 test emails per 10 minutes per signed-in user. */
const testEmailLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `email-test:${String(req.auth?.userId ?? "anonymous")}`,
  handler: (_req, _res, next, options) => {
    next(new HttpError(options.statusCode, "rate_limited", "Too many test emails. Please wait a few minutes and try again."));
  },
});

const testEmailBody = z.object({
  to: z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), emailSchema.optional()),
});

settingsRouter.get("/email/status", editorsOnly, async (_req, res) => {
  res.json(await emailStatus());
});

settingsRouter.post("/email/test", editorsOnly, testEmailLimiter, async (req, res) => {
  const { to } = parseBody(testEmailBody, req);
  res.json(await sendTestEmail(to, req));
});

// ── Settings documents ───────────────────────────────────────────────────────

settingsRouter.get("/:key", async (req, res) => {
  res.json(await getSettings(settingsKey(req)));
});

settingsRouter.put("/:key", async (req, res) => {
  res.json(await saveSettings(settingsKey(req), req.body, req));
});
