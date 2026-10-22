/**
 * In-process cache for the public bundle. Every CMS write calls
 * `invalidatePublicCache()`; the next public read rebuilds the bundle once
 * (concurrent readers share the same in-flight build).
 *
 * The cache is per process: when running several API instances, each one
 * rebuilds independently after its own writes and after `PUBLIC_CACHE_TTL_MS`.
 */
export type CachedBundle = {
  /** Serialized `PublicBundle` JSON, sent verbatim. */
  body: string;
  /** Parsed bundle for targeted per-collection reads. */
  data: Record<string, unknown>;
  etag: string;
  version: string;
  builtAt: number;
};

/** Upper bound on staleness for writes made by other processes (scripts, other instances). */
const PUBLIC_CACHE_TTL_MS = 60_000;

let generation = 0;
let cached: CachedBundle | null = null;
let inflight: { generation: number; promise: Promise<CachedBundle> } | null = null;

export function invalidatePublicCache(): void {
  generation += 1;
  cached = null;
}

export async function getCachedBundle(build: () => Promise<CachedBundle>): Promise<CachedBundle> {
  if (cached && Date.now() - cached.builtAt < PUBLIC_CACHE_TTL_MS) return cached;
  if (inflight && inflight.generation === generation) return inflight.promise;

  const startedAt = generation;
  const promise = build()
    .then((result) => {
      // Keep the result only if nothing was written while it was being built.
      if (startedAt === generation) cached = result;
      return result;
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { generation: startedAt, promise };
  return promise;
}
