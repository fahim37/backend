import { z } from "zod";
import type { Paginated } from "../types.js";

export const MAX_PAGE_SIZE = 500;

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

export type PageParams = { page: number; limit: number };

export function pageWindow({ page, limit }: PageParams): { skip: number; limit: number } {
  return { skip: (page - 1) * limit, limit };
}

export function paginated<T>(items: T[], total: number, { page, limit }: PageParams): Paginated<T> {
  return { items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

/**
 * Parses "-updatedAt,title" style sort strings against an allow-list.
 * Unknown fields are ignored; `_id` is appended as a stable tiebreaker.
 */
export function parseSort(
  sort: string | undefined,
  allowed: readonly string[],
  fallback: Record<string, 1 | -1>,
): Record<string, 1 | -1> {
  const result: Record<string, 1 | -1> = {};
  for (const raw of (sort ?? "").split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const direction = token.startsWith("-") ? -1 : 1;
    const field = token.replace(/^[-+]/, "");
    if (allowed.includes(field)) result[field] = direction;
  }
  const order = Object.keys(result).length ? result : { ...fallback };
  if (!("_id" in order)) order._id = 1;
  return order;
}
