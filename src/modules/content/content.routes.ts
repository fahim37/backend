import { Router } from "express";
import { requireObjectId } from "../../lib/object-id.js";
import { parseBody } from "../../middleware/validate.js";
import { COLLECTION_KEYS } from "../../types.js";
import {
  bulkContent,
  bulkSchema,
  createContent,
  deleteContent,
  duplicateContent,
  getContent,
  listContent,
  reorderContent,
  reorderSchema,
  updateContent,
} from "./content.service.js";
import { contentRegistry, type CollectionConfig } from "./registry.js";

/**
 * CRUD router for one content collection. Mounted behind `requireAuth` and
 * `requireWriteAccess`, so every handler here can assume an authenticated
 * user and that non-GET requests come from an editor or admin.
 */
export function createCollectionRouter(config: CollectionConfig): Router {
  const router = Router();
  const what = config.key;

  router.get("/", async (req, res) => {
    res.json(await listContent(config, req.query as Record<string, unknown>));
  });

  router.post("/", async (req, res) => {
    res.status(201).json(await createContent(config, req.body, req));
  });

  router.post("/reorder", async (req, res) => {
    const { ids } = parseBody(reorderSchema, req);
    res.json({ ok: true, ...(await reorderContent(config, ids, req)) });
  });

  router.post("/bulk", async (req, res) => {
    const { action, ids } = parseBody(bulkSchema, req);
    res.json({ ok: true, ...(await bulkContent(config, action, ids, req)) });
  });

  router.get("/:id", async (req, res) => {
    res.json(await getContent(config, requireObjectId(req.params.id, what)));
  });

  router.patch("/:id", async (req, res) => {
    res.json(await updateContent(config, requireObjectId(req.params.id, what), req.body, req));
  });

  router.delete("/:id", async (req, res) => {
    await deleteContent(config, requireObjectId(req.params.id, what), req);
    res.json({ ok: true });
  });

  router.post("/:id/duplicate", async (req, res) => {
    res.status(201).json(await duplicateContent(config, requireObjectId(req.params.id, what), req));
  });

  return router;
}

/** One router per collection in `COLLECTION_KEYS`, mounted at `/<collection>`. */
export function createContentRouter(): Router {
  const router = Router();
  for (const key of COLLECTION_KEYS) router.use(`/${key}`, createCollectionRouter(contentRegistry[key]));
  return router;
}
