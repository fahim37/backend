import { escapeHtml, singleLine } from "../../lib/mailer.js";
import type { EnquiryRecord } from "../../models/enquiry.js";

/**
 * Email templates for enquiry notifications. Every visitor-supplied value is
 * escaped for HTML and flattened to one line where it lands in a header-like
 * spot; styles are inline because most mail clients ignore <style> blocks.
 */

export type EnquiryForEmail = Pick<
  EnquiryRecord,
  "name" | "email" | "phone" | "company" | "service" | "budget" | "message" | "source" | "createdAt"
> & { id: string };

export type RenderedEmail = { subject: string; html: string; text: string };

type Links = { adminUrl?: string; siteUrl?: string };
type Detail = { label: string; value?: string; href?: string };

const ACCENT = "#ff801b";
/** The accent darkened for small text on white (contrast ≥ 4.5:1). */
const ACCENT_TEXT = "#b4530a";
const INK = "#18181b";
const MUTED = "#71717a";
const LINE = "#ececee";
const PAGE = "#f4f4f5";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const dhakaTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Dhaka",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

export function formatDhakaTime(date: Date): string {
  return `${dhakaTime.format(date)} (Dhaka time)`;
}

/** Keeps line breaks (normalised to \n) but drops other control characters and runs of blank lines. */
function multiline(value: string): string {
  return (
    value
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** A link to the page the form was sent from, only when it is a path on the website itself. */
function sourceHref(source: string, siteUrl: string | undefined): string | undefined {
  if (!siteUrl || !source.startsWith("/")) return undefined;
  try {
    const base = new URL(siteUrl);
    const url = new URL(source, base);
    return url.origin === base.origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function telHref(phone: string): string | undefined {
  const dialable = phone.replace(/[^\d+]/g, "");
  return /^\+?\d{6,15}$/.test(dialable) ? `tel:${dialable}` : undefined;
}

function detailRowsHtml(details: Detail[]): string {
  return details
    .map(({ label, value, href }) => {
      const content = !value
        ? `<span style="color:${MUTED};">Not provided</span>`
        : href
          ? `<a href="${escapeHtml(href)}" style="color:${INK};text-decoration:underline;">${escapeHtml(value)}</a>`
          : escapeHtml(value);
      return (
        `<tr>` +
        `<td style="padding:9px 16px 9px 0;border-bottom:1px solid ${LINE};width:96px;vertical-align:top;font-size:13px;line-height:20px;color:${MUTED};white-space:nowrap;">${escapeHtml(label)}</td>` +
        `<td style="padding:9px 0;border-bottom:1px solid ${LINE};vertical-align:top;font-size:14px;line-height:20px;color:${INK};word-break:break-word;">${content}</td>` +
        `</tr>`
      );
    })
    .join("");
}

function detailRowsText(details: Detail[]): string {
  return details.map(({ label, value }) => `${`${label}:`.padEnd(10)} ${value || "Not provided"}`).join("\n");
}

function buttonHtml(action: { label: string; href: string }): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="border-radius:999px;background:${ACCENT};">` +
    `<a href="${escapeHtml(action.href)}" style="display:inline-block;padding:13px 24px;border-radius:999px;background:${ACCENT};color:#161616;font-family:${FONT};font-size:14px;font-weight:600;line-height:18px;text-decoration:none;">${escapeHtml(action.label)}</a>` +
    `</td></tr></table>`
  );
}

/** The shared frame: accent bar, heading block, trusted body HTML, optional button and footer. */
function layout(input: {
  title: string;
  preheader: string;
  eyebrow: string;
  heading: string;
  subheading?: string;
  bodyHtml: string;
  action?: { label: string; href: string };
  /** Plain text shown under the button. */
  note?: string;
  footer: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAGE};">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;font-family:${FONT};color:${INK};">
<tr><td style="height:5px;line-height:5px;font-size:0;background:${ACCENT};border-radius:14px 14px 0 0;">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 4px;">
<p style="margin:0 0 8px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${ACCENT_TEXT};">${escapeHtml(input.eyebrow)}</p>
<h1 style="margin:0;font-size:22px;line-height:30px;font-weight:700;color:${INK};word-break:break-word;">${escapeHtml(input.heading)}</h1>
${input.subheading ? `<p style="margin:6px 0 0;font-size:14px;line-height:20px;color:${MUTED};">${escapeHtml(input.subheading)}</p>` : ""}
</td></tr>
<tr><td style="padding:20px 32px 8px;">
${input.bodyHtml}
</td></tr>
${
  input.action
    ? `<tr><td style="padding:16px 32px 4px;">${buttonHtml(input.action)}</td></tr>`
    : ""
}
${input.note ? `<tr><td style="padding:12px 32px 0;font-size:13px;line-height:20px;color:${MUTED};">${escapeHtml(input.note)}</td></tr>` : ""}
<tr><td style="padding:24px 32px 28px;"></td></tr>
</table>
<p style="max-width:560px;margin:16px auto 0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(input.footer)}</p>
</td></tr>
</table>
</body>
</html>`;
}

/** The notification sent to the team for each new contact-form enquiry. */
export function renderEnquiryNotification(enquiry: EnquiryForEmail, links: Links): RenderedEmail {
  const name = singleLine(enquiry.name, 80) || "a website visitor";
  const service = singleLine(enquiry.service, 60);
  const subject = singleLine(`New enquiry from ${name}${service ? ` — ${service}` : ""}`, 150);
  const received = formatDhakaTime(enquiry.createdAt);
  const email = singleLine(enquiry.email, 254);
  const phone = singleLine(enquiry.phone, 60);
  const source = singleLine(enquiry.source, 300);
  const message = multiline(enquiry.message);
  const inbox = links.adminUrl ? `${links.adminUrl}/admin/enquiries?open=${encodeURIComponent(enquiry.id)}` : undefined;

  const details: Detail[] = [
    { label: "Name", value: singleLine(enquiry.name, 120) },
    { label: "Email", value: email, href: email ? `mailto:${email}` : undefined },
    { label: "Phone", value: phone, href: phone ? telHref(phone) : undefined },
    { label: "Company", value: singleLine(enquiry.company, 150) },
    { label: "Service", value: singleLine(enquiry.service, 150) },
    { label: "Budget", value: singleLine(enquiry.budget, 100) },
    { label: "Page", value: source, href: source ? sourceHref(source, links.siteUrl) : undefined },
    { label: "Received", value: received },
  ];

  const messageHtml = escapeHtml(message).replace(/\n/g, "<br>");
  const bodyHtml =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${LINE};">${detailRowsHtml(details)}</table>` +
    `<p style="margin:24px 0 8px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};">Message</p>` +
    `<div style="padding:14px 16px;background:#fafafa;border-left:3px solid ${ACCENT};border-radius:0 8px 8px 0;font-size:15px;line-height:24px;color:${INK};word-break:break-word;">${messageHtml}</div>`;

  const replyHint = `Reply to this email to answer ${name} directly.`;
  const html = layout({
    title: subject,
    preheader: singleLine(message, 140),
    eyebrow: "New website enquiry",
    heading: name,
    subheading: `${service || "No service selected"} · ${received}`,
    bodyHtml,
    action: inbox ? { label: "Open in the admin", href: inbox } : undefined,
    note: inbox ? replyHint : `${replyHint} It is also in the Enquiries inbox of the admin panel.`,
    footer:
      "You're receiving this because this address gets enquiry notifications from the SRS IT website. Change it in Admin → Site settings.",
  });

  const text = [
    `New enquiry from ${name}`,
    "",
    detailRowsText(details),
    "",
    "Message:",
    message,
    "",
    inbox ? `Open in the admin: ${inbox}` : "Open the Enquiries inbox in the admin panel to follow it up.",
    `Reply to this email to answer ${name} directly.`,
    "",
    "--",
    "You're receiving this because this address gets enquiry notifications from the SRS IT website. Change it in Admin → Site settings.",
  ].join("\n");

  return { subject, html, text };
}

/** The message behind "Send test email" in Site settings. */
export function renderTestEmail(input: { recipient: string; requestedBy?: string; sentAt: Date; adminUrl?: string }): RenderedEmail {
  const subject = "Test email from the SRS IT website";
  const who = singleLine(input.requestedBy, 80) || "an administrator";
  const when = formatDhakaTime(input.sentAt);
  const inbox = input.adminUrl ? `${input.adminUrl}/admin/enquiries` : undefined;
  const lines = [
    `Email sending works. ${who} sent this test from Admin → Site settings on ${when}.`,
    `New contact-form enquiries are emailed to ${input.recipient}, with Reply-To set to the visitor so you can answer them directly.`,
  ];

  const html = layout({
    title: subject,
    preheader: "Email notifications for new enquiries are working.",
    eyebrow: "Email check",
    heading: "Enquiry notifications are working",
    bodyHtml: lines.map((line) => `<p style="margin:0 0 12px;font-size:15px;line-height:24px;color:${INK};">${escapeHtml(line)}</p>`).join(""),
    action: inbox ? { label: "Open the enquiries inbox", href: inbox } : undefined,
    footer: "Sent by the SRS IT website admin to check email delivery. No action is needed.",
  });

  const text = [subject, "", ...lines, ...(inbox ? ["", `Enquiries inbox: ${inbox}`] : [])].join("\n");
  return { subject, html, text };
}
