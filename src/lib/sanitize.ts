const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Removes keys that MongoDB would interpret as operators ("$where", "$gt", ...)
 * or as dotted paths ("profile.role") from untrusted input, recursively, along
 * with prototype-pollution keys. Returns a new value; the input is not mutated.
 */
export function stripMongoOperators<T>(value: T, depth = 0): T {
  if (depth > 32) return value;
  if (Array.isArray(value)) {
    return value.map((item: unknown) => stripMongoOperators(item, depth + 1)) as T;
  }
  if (isPlainObject(value)) {
    const clean: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("$") || key.includes(".") || FORBIDDEN_KEYS.has(key)) continue;
      clean[key] = stripMongoOperators(child, depth + 1);
    }
    return clean as T;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
