import { invalidatePublicCache } from "./public-cache.js";
import { scheduleRevalidation } from "./revalidate.js";

/**
 * Call after every write that can change what the public site renders
 * (content, settings, media metadata): drops the in-process public bundle and
 * schedules a debounced revalidation of the Next.js site.
 */
export function notifyContentChanged(): void {
  invalidatePublicCache();
  scheduleRevalidation(["cms"]);
}
