import type { Request } from "express";
import { Types } from "mongoose";
import { ActivityModel, type ActivityAction } from "../models/activity.js";
import { logger } from "./logger.js";

export type ActivityInput = {
  action: ActivityAction;
  /** Collection or area, e.g. "solutions", "settings:home", "users", "media". */
  entity: string;
  entityId?: string | Types.ObjectId;
  /** Human label shown in the feed, e.g. the document title. */
  label?: string;
};

type Actor = Request | Types.ObjectId | string | null | undefined;

function actorId(actor: Actor): Types.ObjectId | string | null {
  if (!actor) return null;
  if (typeof actor === "string" || actor instanceof Types.ObjectId) return actor;
  return actor.auth?.userId ?? null;
}

/**
 * Records an audit entry. Never throws: a failed audit write is logged and
 * must not fail the user's request. Pass the request (uses `req.auth`) or a
 * user id.
 */
export async function logActivity(actor: Actor, input: ActivityInput): Promise<void> {
  try {
    await ActivityModel.create({
      user: actorId(actor),
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ? String(input.entityId) : undefined,
      label: input.label?.slice(0, 300),
    });
  } catch (error) {
    logger.error({ err: error, activity: input }, "failed to record activity");
  }
}
