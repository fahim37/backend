/**
 * Creates or promotes the admin from ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME.
 *   npm run create-admin            # create if missing, promote to admin if not
 *   npm run create-admin -- --reset # also reset the password and reactivate
 */
import { env } from "../config/env.js";
import { connectDb, disconnectDb } from "../db.js";
import { upsertAdminFromEnv } from "../lib/bootstrap.js";
import { logger } from "../lib/logger.js";

async function run(): Promise<void> {
  const resetPassword = process.argv.includes("--reset");
  await connectDb();
  try {
    const result = await upsertAdminFromEnv({ resetPassword });
    logger.info({ email: env.ADMIN_EMAIL?.toLowerCase(), result }, "admin account ready");
  } finally {
    await disconnectDb();
  }
}

run().catch((error: unknown) => {
  logger.error({ err: error instanceof Error ? error.message : error }, "create-admin failed");
  process.exitCode = 1;
});
