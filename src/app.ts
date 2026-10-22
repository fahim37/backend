import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { sanitizeInput } from "./middleware/sanitize.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { publicRouter } from "./modules/public/public.routes.js";
import { healthRouter } from "./modules/system/system.routes.js";
import { createAdminRouter } from "./routes/admin.js";

/** Builds the Express app without listening or connecting (tests and scripts can reuse it). */
export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  if (env.isProduction) app.set("trust proxy", env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === "/api/health" },
      customLogLevel: (_req, res, error) => (error || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || env.CORS_ORIGINS.includes(origin)),
      credentials: true,
      maxAge: 600,
      exposedHeaders: ["ETag", "X-Content-Version", "Content-Disposition"],
    }),
  );
  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));
  app.use(sanitizeInput);

  app.use("/api/health", healthRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/public", publicRouter);
  app.use("/api/admin", createAdminRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
