import mongoose from "mongoose";
import type { MongoMemoryServer } from "mongodb-memory-server";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import "./models/index.js";

let memoryServer: MongoMemoryServer | null = null;

mongoose.set("strictQuery", true);

export type DbState = "connected" | "connecting" | "disconnected" | "disconnecting";

export function dbState(): DbState {
  switch (mongoose.connection.readyState) {
    case mongoose.ConnectionStates.connected:
      return "connected";
    case mongoose.ConnectionStates.connecting:
      return "connecting";
    case mongoose.ConnectionStates.disconnecting:
      return "disconnecting";
    default:
      return "disconnected";
  }
}

async function resolveUri(): Promise<string> {
  if (!env.isMemoryDb) return env.MONGODB_URI;
  // Dev dependency: only loaded when explicitly requested with MONGODB_URI=memory.
  const { MongoMemoryServer } = await import("mongodb-memory-server");
  memoryServer = await MongoMemoryServer.create();
  logger.warn("using an in-memory MongoDB; data is discarded when the process exits");
  return memoryServer.getUri();
}

/** Connects, then makes sure every model's indexes (unique slugs, TTLs) exist. */
export async function connectDb(): Promise<typeof mongoose> {
  const uri = await resolveUri();
  mongoose.connection.on("disconnected", () => logger.warn("mongodb disconnected"));
  mongoose.connection.on("reconnected", () => logger.info("mongodb reconnected"));
  mongoose.connection.on("error", (error: unknown) => logger.error({ err: error }, "mongodb connection error"));

  await mongoose.connect(uri, {
    dbName: env.MONGODB_DB,
    serverSelectionTimeoutMS: 15_000,
    maxPoolSize: 20,
    autoIndex: false,
  });
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
  logger.info({ db: env.MONGODB_DB, memory: env.isMemoryDb }, "mongodb connected");
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}
