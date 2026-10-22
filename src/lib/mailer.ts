import nodemailer, { type Transporter } from "nodemailer";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Outgoing email over SMTP (nodemailer).
 *
 * Email is optional: while SMTP_HOST is empty every send is a no-op that
 * resolves `{ sent: false, reason: "not_configured" }`, so callers never need
 * to check first. Sends never throw; failures resolve
 * `{ sent: false, reason: "send_failed", error }` with credentials removed
 * from the error text. MAIL_TRANSPORT=json renders messages without
 * delivering them (tests and local debugging).
 */

export type MailerSettings = {
  /** SMTP server. Email is off while this is empty. */
  host?: string;
  port: number;
  /** Implicit TLS (port 465). When false, STARTTLS is still used if the server offers it. */
  secure: boolean;
  user?: string;
  pass?: string;
  /** Sender, e.g. `SRS IT Website <no-reply@example.com>`; defaults to SMTP_USER when that is an address. */
  from?: string;
  transport: "smtp" | "json";
  /** Base URL of the admin site, for links in emails. */
  adminUrl?: string;
};

export type MailAddress = { name: string; address: string };

export type OutgoingMail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: MailAddress;
};

export type MailFailureReason = "not_configured" | "send_failed";

export type SendResult =
  | { sent: true; messageId: string; /** The rendered message (JSON transport only). */ message?: string }
  | { sent: false; reason: MailFailureReason; error: string };

export type MailerStatus =
  | { configured: true; from: string; transport: MailerSettings["transport"] }
  | { configured: false; issue: string };

type MailerState =
  | { enabled: true; settings: MailerSettings; sender: MailAddress; transporter: Transporter }
  | { enabled: false; settings: MailerSettings; issue: string };

type MailListener = (result: SendResult, mail: OutgoingMail) => void;

const DEFAULT_SENDER_NAME = "SRS IT Website";
const CONNECT_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 30_000;
const FLUSH_TIMEOUT_MS = 10_000;
const MAX_ERROR_LENGTH = 300;

const ERROR_HINTS: Record<string, string> = {
  EAUTH: "The email server rejected the SMTP username or password",
  ENOAUTH: "The email server requires a login (set SMTP_USER and SMTP_PASS)",
  ECONNECTION: "The connection to the email server failed",
  ETIMEDOUT: "The email server did not respond in time",
  ESOCKET: "The connection to the email server failed",
  EDNS: "The email server's host name could not be resolved",
  ETLS: "The secure (TLS) connection to the email server failed",
  EPROTOCOL: "The email server replied unexpectedly",
  EENVELOPE: "The email server refused the sender or recipient address",
  EMESSAGE: "The email server rejected the message",
};

let state: MailerState | undefined;
const inFlight = new Set<Promise<unknown>>();
const listeners = new Set<MailListener>();

// ── Text helpers shared by email templates ───────────────────────────────────

const emailAddressSchema = z.email();

export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && emailAddressSchema.safeParse(value).success;
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** One printable line: CR/LF and other control characters become spaces; at most `max` characters. */
export function singleLine(value: string | null | undefined, max = 200): string {
  const line = (value ?? "").replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

export function formatAddress({ name, address }: MailAddress): string {
  return name ? `${name} <${address}>` : address;
}

/** Accepts `address@domain`, `Name <address@domain>` or `"Name" <address@domain>`. */
function parseSender(value: string): MailAddress | null {
  const match = /^(?:"?([^"<>]*?)"?\s*)?<([^<>\s]+)>$/.exec(value.trim());
  const address = match ? (match[2] ?? "") : value.trim();
  if (!isEmailAddress(address)) return null;
  return { name: singleLine(match?.[1], 100) || DEFAULT_SENDER_NAME, address };
}

// ── Configuration ────────────────────────────────────────────────────────────

export function mailerSettingsFromEnv(): MailerSettings {
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM,
    transport: env.MAIL_TRANSPORT,
    adminUrl: (env.ADMIN_URL ?? env.SITE_URL)?.replace(/\/+$/, ""),
  };
}

function buildState(settings: MailerSettings): MailerState {
  const disabled = (issue: string): MailerState => ({ enabled: false, settings, issue });
  if (!settings.host) return disabled("SMTP_HOST is not set");
  if (settings.transport === "smtp" && settings.user && !settings.pass) return disabled("SMTP_USER is set but SMTP_PASS is empty");

  let sender: MailAddress | null;
  if (settings.from) {
    sender = parseSender(settings.from);
    if (!sender) return disabled("MAIL_FROM is not a valid address (use Name <address@domain>)");
  } else if (isEmailAddress(settings.user)) {
    sender = { name: DEFAULT_SENDER_NAME, address: settings.user };
  } else {
    return disabled("MAIL_FROM is not set");
  }

  // Messages are built from our own strings only; never let content pull in local files or URLs.
  const safety = { disableFileAccess: true, disableUrlAccess: true };
  const transporter: Transporter =
    settings.transport === "json"
      ? nodemailer.createTransport({ jsonTransport: true, ...safety })
      : nodemailer.createTransport({
          host: settings.host,
          port: settings.port,
          secure: settings.secure,
          auth: settings.user ? { user: settings.user, pass: settings.pass ?? "" } : undefined,
          connectionTimeout: CONNECT_TIMEOUT_MS,
          greetingTimeout: CONNECT_TIMEOUT_MS,
          socketTimeout: SOCKET_TIMEOUT_MS,
          ...safety,
        });
  return { enabled: true, settings, sender, transporter };
}

function install(settings: MailerSettings): MailerState {
  if (state?.enabled) state.transporter.close();
  const next = buildState(settings);
  state = next;

  if (!next.enabled) {
    logger[env.isProduction ? "warn" : "info"](
      { issue: next.issue },
      "email is off: new enquiries are stored in the admin inbox but not emailed",
    );
  } else if (next.settings.transport === "json") {
    logger.warn({ from: formatAddress(next.sender) }, "MAIL_TRANSPORT=json: emails are rendered but not delivered");
  } else {
    logger.info(
      { host: next.settings.host, port: next.settings.port, secure: next.settings.secure, from: formatAddress(next.sender) },
      "email is on",
    );
  }
  return next;
}

/**
 * (Re)builds the transport, by default from the environment, and logs whether
 * email is on. The API calls it once at boot; tests pass explicit settings to
 * switch between configurations.
 */
export function configureMailer(settings: MailerSettings = mailerSettingsFromEnv()): MailerStatus {
  install(settings);
  return mailerStatus();
}

function current(): MailerState {
  return state ?? install(mailerSettingsFromEnv());
}

export function mailerStatus(): MailerStatus {
  const mailer = current();
  return mailer.enabled
    ? { configured: true, from: formatAddress(mailer.sender), transport: mailer.settings.transport }
    : { configured: false, issue: mailer.issue };
}

export function isEmailConfigured(): boolean {
  return current().enabled;
}

/** `${ADMIN_URL}${path}` (ADMIN_URL defaults to SITE_URL), or undefined when neither is set. */
export function adminSiteUrl(path = ""): string | undefined {
  const base = current().settings.adminUrl;
  return base ? `${base}${path}` : undefined;
}

// ── Sending ──────────────────────────────────────────────────────────────────

const notConfiguredMessage = (issue: string) => `Email sending isn't set up on the server (${issue}).`;

/** A short, user-presentable error with SMTP credentials removed. */
function describeMailError(error: unknown, settings: MailerSettings): string {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  let detail = singleLine(error instanceof Error ? error.message : String(error), 1000);
  for (const secret of [settings.pass, settings.user]) {
    if (secret && secret.length >= 3) detail = detail.split(secret).join("[redacted]");
  }
  const hint = ERROR_HINTS[code];
  const message = hint ? `${hint}: ${detail}` : detail || "Unknown email error";
  return singleLine(message, MAX_ERROR_LENGTH);
}

function track<T>(promise: Promise<T>): Promise<T> {
  inFlight.add(promise);
  void promise.then(
    () => inFlight.delete(promise),
    () => inFlight.delete(promise),
  );
  return promise;
}

function emit(result: SendResult, mail: OutgoingMail): void {
  for (const listener of listeners) {
    try {
      listener(result, mail);
    } catch (error) {
      logger.error({ err: error }, "mail listener failed");
    }
  }
}

async function deliver(mail: OutgoingMail): Promise<SendResult> {
  const mailer = current();
  let result: SendResult;
  if (!mailer.enabled) {
    result = { sent: false, reason: "not_configured", error: notConfiguredMessage(mailer.issue) };
  } else if (!isEmailAddress(mail.to)) {
    result = { sent: false, reason: "send_failed", error: "The recipient address is not a valid email address." };
  } else {
    const replyTo = mail.replyTo && isEmailAddress(mail.replyTo.address) ? mail.replyTo : undefined;
    try {
      const info: object & { messageId: string } = await mailer.transporter.sendMail({
        from: mailer.sender,
        to: mail.to,
        replyTo: replyTo ? { name: singleLine(replyTo.name, 100), address: replyTo.address } : undefined,
        subject: singleLine(mail.subject, 200),
        text: mail.text,
        html: mail.html,
      });
      const message = "message" in info && typeof info.message === "string" ? info.message : undefined;
      result = { sent: true, messageId: info.messageId, ...(message !== undefined ? { message } : {}) };
    } catch (error) {
      result = { sent: false, reason: "send_failed", error: describeMailError(error, mailer.settings) };
    }
  }
  emit(result, mail);
  return result;
}

/** Sends one message. Never rejects; see `SendResult`. */
export function sendMail(mail: OutgoingMail): Promise<SendResult> {
  return track(deliver(mail));
}

/**
 * Runs an email job without making the caller wait (e.g. after answering an
 * HTTP request). Errors are logged with `context`; `flushMail()` waits for it.
 */
export function sendInBackground(job: () => Promise<unknown>, context: Record<string, unknown> = {}): void {
  void track(
    Promise.resolve()
      .then(job)
      .catch((error: unknown) => logger.error({ err: error, ...context }, "background email job failed")),
  );
}

/** Checks that the SMTP server accepts a connection and login (the JSON transport always passes). */
export async function verifyMailer(): Promise<{ ok: true } | { ok: false; reason: MailFailureReason; error: string }> {
  const mailer = current();
  if (!mailer.enabled) return { ok: false, reason: "not_configured", error: notConfiguredMessage(mailer.issue) };
  if (mailer.settings.transport === "json") return { ok: true };
  try {
    await mailer.transporter.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "send_failed", error: describeMailError(error, mailer.settings) };
  }
}

/** Waits (bounded) for in-flight sends and background jobs: graceful shutdown and tests. */
export async function flushMail(timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0 && Date.now() < deadline) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      timer.unref();
    });
    await Promise.race([Promise.allSettled([...inFlight]), timeout]);
    clearTimeout(timer);
  }
}

/** Observes every send attempt, successful or not (diagnostics and tests). Returns an unsubscribe function. */
export function onMailSettled(listener: MailListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
