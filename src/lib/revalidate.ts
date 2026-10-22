import { env } from "../config/env.js";
import { logger } from "./logger.js";

const DEBOUNCE_MS = 500;
const REQUEST_TIMEOUT_MS = 8000;

let timer: NodeJS.Timeout | null = null;
const pendingTags = new Set<string>();

export type RevalidateResult = { ok: boolean; skipped?: boolean; status?: number; error?: string };

/** POSTs `{ tags }` to the site's revalidation route. Never throws. */
export async function revalidateSite(tags: string[] = ["cms"]): Promise<RevalidateResult> {
  if (!env.SITE_URL) return { ok: true, skipped: true };
  const url = `${env.SITE_URL}/api/revalidate`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-revalidate-secret": env.REVALIDATE_SECRET ?? "",
      },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn({ status: response.status, tags }, "site revalidation was rejected");
      return { ok: false, status: response.status, error: `Site responded with ${response.status}` };
    }
    logger.debug({ tags }, "site revalidated");
    return { ok: true, status: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: message, tags }, "site revalidation failed");
    return { ok: false, error: message };
  }
}

/** Debounced, fire-and-forget revalidation: a burst of writes produces one request. */
export function scheduleRevalidation(tags: string[] = ["cms"]): void {
  if (!env.SITE_URL) return;
  for (const tag of tags) pendingTags.add(tag);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const batch = [...pendingTags];
    pendingTags.clear();
    void revalidateSite(batch);
  }, DEBOUNCE_MS);
}

/** Sends a pending debounced revalidation immediately (used on shutdown). */
export async function flushRevalidation(): Promise<void> {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  const batch = [...pendingTags];
  pendingTags.clear();
  if (batch.length) await revalidateSite(batch);
}
