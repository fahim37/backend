import { Router, type Request, type Response } from "express";
import { notFound } from "../../lib/errors.js";
import { publicEnquiryRouter } from "../enquiries/enquiries.routes.js";
import { isCollectionKey } from "../content/registry.js";
import { isSettingsKey } from "../settings/settings.service.js";
import { getPublicBundle, getPublicCollection, getPublicItem, getPublicSettings } from "./public.service.js";

export const PUBLIC_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=600";

function matchesEtag(req: Request, etag: string): boolean {
  const header = req.get("if-none-match");
  if (!header) return false;
  if (header.trim() === "*") return true;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === bare);
}

/** Sends JSON with validators and shared-cache headers; answers 304 when the client is current. */
function sendCached(req: Request, res: Response, etag: string, body: string | unknown, version?: string): void {
  res.setHeader("Cache-Control", PUBLIC_CACHE_CONTROL);
  res.setHeader("ETag", etag);
  res.setHeader("Vary", "Accept-Encoding");
  if (version) res.setHeader("X-Content-Version", version);
  if (matchesEtag(req, etag)) {
    res.status(304).end();
    return;
  }
  res.type("application/json").send(typeof body === "string" ? body : JSON.stringify(body));
}

export const publicRouter = Router();

publicRouter.use("/enquiries", publicEnquiryRouter);

publicRouter.get("/bundle", async (req, res) => {
  const bundle = await getPublicBundle();
  sendCached(req, res, bundle.etag, bundle.body, bundle.version);
});

publicRouter.get("/settings/:key", async (req, res) => {
  const key = req.params.key;
  if (!isSettingsKey(key)) throw notFound(`Unknown settings "${key}"`);
  const { data, etag } = await getPublicSettings(key);
  sendCached(req, res, etag, data);
});

publicRouter.get("/:collection", async (req, res) => {
  const key = req.params.collection;
  if (!isCollectionKey(key)) throw notFound(`Unknown collection "${key}"`);
  const { items, etag } = await getPublicCollection(key);
  sendCached(req, res, etag, items);
});

// "*slug" so redirect sources and nested page keys ("legal/terms") resolve too.
publicRouter.get("/:collection/*slug", async (req, res) => {
  const key = req.params.collection;
  if (!isCollectionKey(key)) throw notFound(`Unknown collection "${key}"`);
  const segments = req.params.slug as unknown as string[] | string;
  const identifier = Array.isArray(segments) ? segments.join("/") : segments;
  const found = await getPublicItem(key, identifier);
  if (!found) throw notFound("Not found");
  sendCached(req, res, found.etag, found.item);
});
