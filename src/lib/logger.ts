import { pino } from "pino";
import { env } from "../config/env.js";

const usePretty = !env.isProduction && process.stdout.isTTY === true;

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "srsit-cms-api" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "*.password",
      "*.passwordHash",
      "*.newPassword",
      "*.currentPassword",
    ],
    censor: "[redacted]",
  },
  ...(usePretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname,service" },
        },
      }
    : {}),
});

export type Logger = typeof logger;
