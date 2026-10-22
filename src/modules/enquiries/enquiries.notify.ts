import type { Request } from "express";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import {
  adminSiteUrl,
  isEmailAddress,
  isEmailConfigured,
  mailerStatus,
  sendInBackground,
  sendMail,
  verifyMailer,
} from "../../lib/mailer.js";
import { getSettings } from "../settings/settings.service.js";
import { renderEnquiryNotification, renderTestEmail, type EnquiryForEmail } from "./enquiries.email.js";

/** GET /api/admin/settings/email/status */
export type EmailStatus = {
  configured: boolean;
  /** Sender address, when configured. */
  from?: string;
  /** Where enquiry notifications go right now (saved setting, else ADMIN_EMAIL). */
  to: string | null;
  /** Why email is off, e.g. "SMTP_HOST is not set". */
  issue?: string;
};

/** Site settings → Enquiry notifications when set, otherwise the server's ADMIN_EMAIL. */
export async function notificationRecipient(): Promise<string | null> {
  const site = await getSettings("site");
  const saved = site.notificationEmail?.trim();
  if (saved && isEmailAddress(saved)) return saved;
  return env.ADMIN_EMAIL ?? null;
}

/**
 * Emails a new enquiry to the team. Runs in the background: it never throws
 * and never delays the response to the visitor. Nothing is ever sent to the
 * visitor's address; it is only used as Reply-To.
 */
export function notifyNewEnquiry(enquiry: EnquiryForEmail): void {
  if (!isEmailConfigured()) return;
  const enquiryId = enquiry.id;
  sendInBackground(
    async () => {
      const to = await notificationRecipient();
      if (!to) {
        logger.warn({ enquiryId }, "enquiry notification skipped: no recipient (set Site settings → Enquiry notifications or ADMIN_EMAIL)");
        return;
      }
      const result = await sendMail({
        to,
        ...renderEnquiryNotification(enquiry, { adminUrl: adminSiteUrl(), siteUrl: env.SITE_URL }),
        replyTo: { name: enquiry.name, address: enquiry.email },
      });
      if (result.sent) logger.info({ enquiryId, messageId: result.messageId }, "enquiry notification emailed");
      else logger.error({ enquiryId, reason: result.reason, error: result.error }, "enquiry notification email failed");
    },
    { enquiryId },
  );
}

export async function emailStatus(): Promise<EmailStatus> {
  const status = mailerStatus();
  const to = await notificationRecipient();
  return status.configured ? { configured: true, from: status.from, to } : { configured: false, to, issue: status.issue };
}

/**
 * Sends the "Send test email" message to `requested` or the current
 * notification address. 400 when email is off or there is no recipient,
 * 502 with the SMTP server's answer when sending fails.
 */
export async function sendTestEmail(requested: string | undefined, req: Request): Promise<{ sent: true; to: string }> {
  const status = mailerStatus();
  if (!status.configured) {
    throw new HttpError(400, "not_configured", `Email sending isn't set up on the server yet (${status.issue}).`);
  }
  const recipient = await notificationRecipient();
  const to = requested ?? recipient;
  if (!to) {
    throw new HttpError(400, "no_recipient", "There is no address to send to. Enter one under Enquiry notifications and save first.");
  }

  const verified = await verifyMailer();
  const result = verified.ok
    ? await sendMail({
        to,
        ...renderTestEmail({ recipient: recipient ?? to, requestedBy: req.auth?.name, sentAt: new Date(), adminUrl: adminSiteUrl() }),
      })
    : ({ sent: false, reason: verified.reason, error: verified.error } as const);

  if (!result.sent) {
    logger.warn({ userId: String(req.auth?.userId ?? ""), reason: result.reason, error: result.error }, "test email failed");
    if (result.reason === "not_configured") throw new HttpError(400, "not_configured", result.error);
    throw new HttpError(502, "smtp_error", `The email server didn't accept the test message. ${result.error}`);
  }
  logger.info({ userId: String(req.auth?.userId ?? ""), messageId: result.messageId }, "test email sent");
  return { sent: true, to };
}
