import { Router } from "express";
import { dbState } from "../../db.js";
import { logActivity } from "../../lib/activity.js";
import { invalidatePublicCache } from "../../lib/public-cache.js";
import { revalidateSite } from "../../lib/revalidate.js";

/** GET /api/health — liveness plus database state. */
export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  const db = dbState();
  res.setHeader("Cache-Control", "no-store");
  res.status(db === "connected" ? 200 : 503).json({ ok: db === "connected", db });
});

/** POST /api/admin/revalidate — drops the API cache and revalidates the site now. */
export const revalidateRouter = Router();

revalidateRouter.post("/", async (req, res) => {
  invalidatePublicCache();
  const result = await revalidateSite(["cms"]);
  await logActivity(req, { action: "revalidate", entity: "site", label: result.ok ? "Site cache cleared" : "Site revalidation failed" });
  res.status(result.ok ? 200 : 502).json(
    result.ok
      ? { ok: true, revalidated: !result.skipped, at: new Date().toISOString() }
      : { error: { message: "The website did not accept the revalidation request", code: "revalidate_failed", details: result } },
  );
});
