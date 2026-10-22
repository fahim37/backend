import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import { notFound } from "./errors.js";

const OBJECT_ID = /^[a-f\d]{24}$/i;

export const objectIdString = z.string().regex(OBJECT_ID, "Invalid id");

export function isObjectIdString(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID.test(value) && isValidObjectId(value);
}

/** A path id that is not an ObjectId cannot match a document, so it is a 404. */
export function requireObjectId(value: unknown, what = "Resource"): Types.ObjectId {
  if (!isObjectIdString(value)) throw notFound(`${what} not found`);
  return new Types.ObjectId(value);
}
