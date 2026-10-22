import { Router } from "express";
import { requireAuth, requireRole, requireWriteAccess } from "../middleware/auth.js";
import { adminLimiter } from "../middleware/rate-limit.js";
import { activityRouter } from "../modules/activity/activity.routes.js";
import { createContentRouter } from "../modules/content/content.routes.js";
import { dashboardRouter } from "../modules/dashboard/dashboard.routes.js";
import { adminEnquiryRouter } from "../modules/enquiries/enquiries.routes.js";
import { mediaRouter } from "../modules/media/media.routes.js";
import { settingsRouter } from "../modules/settings/settings.routes.js";
import { revalidateRouter } from "../modules/system/system.routes.js";
import { usersRouter } from "../modules/users/users.routes.js";

/**
 * Everything under /api/admin. All routes require a signed-in user; viewers
 * may only read (GET/HEAD), editors and admins may write, and user management
 * is admin-only.
 */
export function createAdminRouter(): Router {
  const router = Router();
  router.use(adminLimiter, requireAuth, requireWriteAccess);
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  router.use("/dashboard", dashboardRouter);
  router.use("/activity", activityRouter);
  router.use("/settings", settingsRouter);
  router.use("/enquiries", adminEnquiryRouter);
  router.use("/users", requireRole("admin"), usersRouter);
  router.use("/revalidate", revalidateRouter);
  // Media before the content collections, which are mounted at the router root.
  router.use("/media", mediaRouter);
  // Content collections last: /solutions, /industries, ... (see COLLECTION_KEYS).
  router.use(createContentRouter());

  return router;
}
