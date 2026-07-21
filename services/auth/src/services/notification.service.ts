import crypto from "crypto";
import nodemailer from "nodemailer";
import { prisma, publishEvent, ensureIdentity, createRecoveryLink, findIdentityBySubject } from "@chatcenter/shared";

type NotificationChannel = "email" | "slack" | "webhook" | "internal";

interface NotificationPayload {
  tenantId: string;
  channel: NotificationChannel;
  type: string;
  recipient: string;
  subject?: string;
  body?: string;
  metadata?: Record<string, any>;
}

// ─── SMTP Transporter (Gmail or any SMTP) ───────────────────

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || "587", 10);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!host || !user || !pass) {
      console.warn("[EMAIL] SMTP not configured (SMTP_HOST, SMTP_USER, SMTP_PASS required). Emails will be logged only.");
      return {
        sendMail: async (opts: any) => {
          console.log(`[EMAIL-STUB] To: ${opts.to} | Subject: ${opts.subject}`);
          console.log(`[EMAIL-STUB] HTML preview: ${(opts.html || opts.text || "").substring(0, 300)}...`);
          return { messageId: `stub-${Date.now()}` };
        },
      } as any;
    }

    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });

    console.log(`[EMAIL] SMTP configured: ${host}:${port} (user: ${user})`);
  }
  return transporter;
}

/**
 * True only when real SMTP creds are configured. Without them, getTransporter
 * returns a STUB that only console.logs - so callers that must report HONEST
 * delivery (the Nudge Engine / the AI's Voice) check this to avoid marking an
 * un-sent email as SENT (T-4: "the Voice is mute but the system reports speaking").
 */
export function isEmailTransportConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function logNotification(payload: NotificationPayload, status: "sent" | "failed", error?: string) {
  await prisma.notificationLog.create({
    data: {
      tenantId: payload.tenantId,
      channel: payload.channel,
      type: payload.type,
      recipient: payload.recipient,
      subject: payload.subject,
      body: payload.body,
      status,
      error,
      metadata: payload.metadata || {},
      sentAt: status === "sent" ? new Date() : undefined,
    },
  });
}

async function sendHtmlEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@gotcha.app";
  const mail = getTransporter();
  await mail.sendMail({ from, to, subject, html, text });
  console.log(`[EMAIL] Sent to: ${to} | Subject: ${subject}`);
}

// ─── Setup / Sign-in Links ──────────────────────────────────

/**
 * One-time link that drops a user into Authentik to set their password.
 *
 * This replaces the old home-grown magic link. GOTCHA no longer mints
 * credentials-bearing tokens of any kind: the link is issued by Authentik,
 * expires on Authentik's schedule, and is single-use by Authentik's rules.
 */
export async function createSetupLink(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, identity: { select: { authentikSubject: true } } },
  });
  if (!user) throw new Error("User not found");

  const identity = user.identity?.authentikSubject
    ? await findIdentityBySubject(user.identity.authentikSubject)
    : await ensureIdentity(user.email, user.name);
  if (!identity) throw new Error("No Authentik identity for user");

  return createRecoveryLink(identity.pk);
}

/**
 * Where to send someone who just needs to log in (nudge emails, "come back"
 * links). There is no token to embed: the app bounces them to Authentik, and
 * if they still have a session they land straight in the workspace.
 */
export function signInUrl(): string {
  return process.env.FRONTEND_URL || "http://localhost:3000";
}

// ─── Brand Email System (light, premium, RTL-aware) ─────────
//
// One visual system for every email the product sends: a soft light canvas, a
// single white card with a brand-gradient hairline, generous whitespace, and
// the brand palette used as accents - never as a wall of color. Every template
// below composes this shell; the Nudge Engine imports it too, so the AI's
// Voice and the product's transactional mail read as one product.

const EC = {
  canvas: "#f4f3f9",
  border: "#eae7f2",
  divider: "#f0eef6",
  ink: "#1d1a26",
  body: "#5b556b",
  muted: "#8f89a0",
  faint: "#b3adc2",
  violet: "#7C3291",
  chipBg: "#f6f1fa",
  tint: "#faf9fc",
  tintBorder: "#edeaf3",
  grad: "linear-gradient(90deg,#7C3291 0%,#5A72B3 55%,#6DCED9 100%)",
  gradBtn: "linear-gradient(135deg,#7C3291 0%,#5A72B3 100%)",
} as const;

const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export interface BrandEmailArgs {
  title: string;               // <title>
  preheader?: string;          // hidden inbox preview line
  eyebrow?: string;            // small uppercase label above the headline
  icon?: string;               // emoji / HTML entity rendered in a soft chip
  headline: string;            // escape dynamic parts at the call site
  subhead?: string;
  bodyHtml?: string;           // inner card rows (use the email* helpers)
  cta?: { label: string; url: string };
  fallbackUrl?: string;        // "button not working?" link
  expiryNote?: string;
  closingHtml?: string;        // replaces the default sign-off when set
  belowCardHtml?: string;      // extra block between the card and the footer
  footerNote?: string;         // the "why you got this" line
  locale?: string;             // "he" → RTL
}

export function renderBrandEmail(a: BrandEmailArgs): string {
  const he = a.locale === "he";
  const dir = he ? "rtl" : "ltr";
  const align = he ? "right" : "left";
  const closing = a.closingHtml ?? `
      <p style="margin:0 0 14px;font-size:14px;color:${EC.muted};line-height:1.6;">${he ? "צריכים עזרה? פשוט השיבו למייל - בן אדם אמיתי קורא כל הודעה." : "Need help? Just hit reply &mdash; a real human reads every message."}</p>
      <p style="margin:0;font-size:14px;color:${EC.muted};">${he ? "נתראה בקרוב," : "Talk soon,"}<br><strong style="color:${EC.ink};">${he ? "צוות GOTCHA." : "The GOTCHA. Team"}</strong></p>`;
  return `<!DOCTYPE html>
<html lang="${he ? "he" : "en"}" dir="${dir}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${a.title}</title>
  <!--[if mso]><style>table,td{font-family:Arial,sans-serif;}</style><![endif]-->
</head>
<body dir="${dir}" style="margin:0;padding:0;background-color:${EC.canvas};font-family:${EMAIL_FONT};-webkit-font-smoothing:antialiased;">
  ${a.preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${a.preheader}</div>` : ""}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EC.canvas};">
    <tr><td align="center" style="padding:48px 16px 24px;">

      <!-- wordmark -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
        <tr><td align="center" style="padding-bottom:26px;">
          <span style="font-size:15px;font-weight:800;letter-spacing:4px;color:${EC.ink};">GOTCHA<span style="color:${EC.violet};">.</span></span>
        </td></tr>
      </table>

      <!-- card -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" dir="${dir}" style="width:100%;max-width:560px;background-color:#ffffff;border:1px solid ${EC.border};border-radius:24px;overflow:hidden;box-shadow:0 12px 40px rgba(29,26,38,0.06);">
        <tr><td style="height:5px;background:${EC.grad};font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:44px 44px 0;text-align:${align};">
          ${a.icon ? `<div style="width:58px;height:58px;border-radius:18px;background-color:${EC.chipBg};text-align:center;line-height:58px;font-size:27px;margin-bottom:22px;">${a.icon}</div>` : ""}
          ${a.eyebrow ? `<p style="margin:0 0 10px;font-size:11px;font-weight:700;color:${EC.violet};text-transform:uppercase;letter-spacing:2px;">${a.eyebrow}</p>` : ""}
          <h1 style="margin:0;font-size:28px;font-weight:800;color:${EC.ink};line-height:1.25;letter-spacing:-0.4px;">${a.headline}</h1>
          ${a.subhead ? `<p style="margin:10px 0 0;font-size:16px;color:${EC.body};line-height:1.6;">${a.subhead}</p>` : ""}
        </td></tr>
        ${a.bodyHtml || ""}
        ${a.cta ? `<tr><td style="padding:34px 44px 6px;text-align:${align};">
          <a href="${a.cta.url}" target="_blank" style="display:inline-block;background:${EC.gradBtn};color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;padding:15px 38px;border-radius:14px;box-shadow:0 8px 22px rgba(124,50,145,0.28);mso-padding-alt:15px 38px;">${a.cta.label} ${he ? "&larr;" : "&rarr;"}</a>
        </td></tr>` : ""}
        ${a.fallbackUrl ? `<tr><td style="padding:28px 44px 0;text-align:${align};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${EC.divider};"><tr><td style="padding:20px 0 0;">
            <p style="margin:0;font-size:12px;color:${EC.muted};line-height:1.6;">${he ? "הכפתור לא עובד? העתיקו את הקישור:" : "Button not working? Copy this link:"}<br>
              <a href="${a.fallbackUrl}" style="color:${EC.violet};word-break:break-all;font-size:12px;">${a.fallbackUrl}</a></p>
            ${a.expiryNote ? `<p style="margin:8px 0 0;font-size:12px;color:${EC.faint};">${a.expiryNote}</p>` : ""}
          </td></tr></table>
        </td></tr>` : ""}
        <tr><td style="padding:32px 44px 42px;text-align:${align};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${EC.divider};"><tr><td style="padding:24px 0 0;">${closing}</td></tr></table>
        </td></tr>
      </table>

      ${a.belowCardHtml || ""}

      <!-- footer -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
        <tr><td align="center" style="padding:26px 16px 8px;">
          <p style="margin:0;color:${EC.muted};font-size:11px;line-height:1.7;">${he ? "GOTCHA. - בונים את עתיד התקשורת עם הלקוחות." : "GOTCHA. &mdash; Building the future of customer communication."}</p>
          ${a.footerNote ? `<p style="margin:6px 0 0;color:${EC.faint};font-size:11px;line-height:1.7;">${a.footerNote}</p>` : ""}
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

// Section builders - each returns a full-width card row (<tr>…</tr>).

export function emailParagraph(html: string, locale?: string): string {
  const align = locale === "he" ? "right" : "left";
  return `<tr><td style="padding:26px 44px 0;text-align:${align};"><p style="margin:0;font-size:15px;color:${EC.body};line-height:1.75;">${html}</p></td></tr>`;
}

function emailSteps(caption: string, steps: Array<{ marker: string; title: string; desc: string }>): string {
  const rows = steps.map((s, i) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:${i === steps.length - 1 ? "0" : "18px"};">
      <tr>
        <td style="width:42px;vertical-align:top;padding-top:1px;">
          <div style="width:30px;height:30px;background:${EC.gradBtn};border-radius:50%;text-align:center;line-height:30px;color:#ffffff;font-size:13px;font-weight:800;">${s.marker}</div>
        </td>
        <td style="vertical-align:top;padding-left:14px;">
          <p style="margin:0;font-size:15px;font-weight:700;color:${EC.ink};">${s.title}</p>
          <p style="margin:4px 0 0;font-size:13px;color:${EC.muted};line-height:1.6;">${s.desc}</p>
        </td>
      </tr>
    </table>`).join("");
  return `<tr><td style="padding:32px 44px 0;">
    <p style="margin:0 0 18px;font-size:11px;font-weight:700;color:${EC.violet};text-transform:uppercase;letter-spacing:2px;">${caption}</p>
    ${rows}
  </td></tr>`;
}

function emailStatCards(cards: Array<{ label: string; value: string }>): string {
  const w = Math.floor(100 / Math.max(cards.length, 1));
  const tds = cards.map((c) => `
    <td style="width:${w}%;padding:0 4px;vertical-align:top;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EC.tint};border:1px solid ${EC.tintBorder};border-radius:14px;">
        <tr><td style="padding:16px 12px;text-align:center;">
          <p style="margin:0;font-size:10px;font-weight:700;color:${EC.violet};text-transform:uppercase;letter-spacing:1px;">${c.label}</p>
          <p style="margin:6px 0 0;font-size:14px;font-weight:700;color:${EC.ink};">${c.value}</p>
        </td></tr>
      </table>
    </td>`).join("");
  return `<tr><td style="padding:30px 40px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${tds}</tr></table>
  </td></tr>`;
}

function emailKeyValueTable(headers: [string, string], rows: Array<[string, string]>): string {
  const body = rows.map(([k, v]) => `
      <tr>
        <td style="padding:12px 16px;border-top:1px solid ${EC.divider};font-size:14px;color:${EC.ink};">${k}</td>
        <td style="padding:12px 16px;border-top:1px solid ${EC.divider};text-align:center;font-size:14px;color:${EC.muted};">${v}</td>
      </tr>`).join("");
  return `<tr><td style="padding:26px 44px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EC.tint};border:1px solid ${EC.tintBorder};border-radius:14px;overflow:hidden;">
      <tr>
        <td style="padding:12px 16px;font-size:11px;font-weight:700;color:${EC.muted};text-transform:uppercase;letter-spacing:1px;">${headers[0]}</td>
        <td style="padding:12px 16px;font-size:11px;font-weight:700;color:${EC.muted};text-transform:uppercase;letter-spacing:1px;text-align:center;">${headers[1]}</td>
      </tr>
      ${body}
    </table>
  </td></tr>`;
}

function emailBadge(caption: string, value: string): string {
  return `<tr><td style="padding:30px 44px 0;" align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;background-color:${EC.chipBg};border:1px solid ${EC.tintBorder};border-radius:16px;">
      <tr><td style="padding:16px 36px;text-align:center;">
        <p style="margin:0 0 2px;font-size:10px;font-weight:700;color:${EC.violet};text-transform:uppercase;letter-spacing:2px;">${caption}</p>
        <p style="margin:0;font-size:34px;font-weight:800;color:${EC.ink};letter-spacing:-1px;">${value}</p>
      </td></tr>
    </table>
  </td></tr>`;
}

function emailPills(caption: string, items: string[]): string {
  const rows = items.map((t) => `
      <tr><td style="padding:6px 0;"><span style="font-size:13px;color:${EC.body};"><span style="color:${EC.violet};">&#9670;</span>&nbsp;&nbsp;${t}</span></td></tr>`).join("");
  return `<tr><td style="padding:28px 44px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EC.tint};border:1px solid ${EC.tintBorder};border-radius:14px;">
      <tr><td style="padding:18px 24px 6px;"><p style="margin:0;font-size:10px;font-weight:700;color:${EC.muted};text-transform:uppercase;letter-spacing:1px;">${caption}</p></td></tr>
      <tr><td style="padding:0 24px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>
    </table>
  </td></tr>`;
}

// ─── HTML Email Templates ───────────────────────────────────

export function onboardingEmailHtml(adminName: string, tenantName: string, setupUrl: string): string {
  return renderBrandEmail({
    title: `Set up ${escapeHtml(tenantName)} - GOTCHA.`,
    preheader: "Your workspace is ready - your AI wants to meet your business.",
    eyebrow: "Your workspace is ready",
    icon: "&#9889;",
    headline: `Let's set up ${escapeHtml(tenantName)}.`,
    subhead: `${escapeHtml(adminName)}, your AI employee is ready to meet your business &mdash; it does the reading, you do the approving.`,
    bodyHtml: emailSteps("What happens next", [
      { marker: "1", title: "Watch it investigate your business", desc: "It reads your website end to end and shows you everything it learned." },
      { marker: "2", title: "Meet your first AI employee", desc: "Tuned to your brand voice &mdash; chat with it and shape it before it starts." },
      { marker: "&#10003;", title: "Put it to work", desc: "Connect your channels and it handles real customer conversations from day one." },
    ]),
    cta: { label: "Start setup", url: setupUrl },
    fallbackUrl: setupUrl,
    expiryNote: `This link expires in <strong style="color:#7C3291;">48 hours</strong> &bull; No login required`,
    footerNote: "You're receiving this because your workspace was created on gotcha.co.il",
  });
}

export function activationEmailHtml(
  adminName: string,
  tenantName: string,
  industry: string,
  priority: string,
  departments: { name: string; sla: string }[],
  dashboardUrl: string,
): string {
  return renderBrandEmail({
    title: `${escapeHtml(tenantName)} is live - GOTCHA.`,
    preheader: "Everything's set up and ready to go.",
    eyebrow: "You're live",
    icon: "&#10003;",
    headline: `${escapeHtml(tenantName)} is live.`,
    subhead: `Everything's set up and ready to go, ${escapeHtml(adminName)}.`,
    bodyHtml:
      emailStatCards([
        { label: "Industry", value: escapeHtml(industry) },
        { label: "Priority", value: escapeHtml(priority.replace(/_/g, " ")) },
        { label: "AI Employee", value: "Active" },
      ]) +
      (departments.length
        ? emailKeyValueTable(["Department", "SLA"], departments.map((d) => [escapeHtml(d.name), escapeHtml(d.sla)]))
        : ""),
    cta: { label: "Open dashboard", url: dashboardUrl },
    closingHtml: `<p style="margin:0 0 14px;font-size:14px;color:#8f89a0;line-height:1.6;">Your AI employee is standing by &mdash; ready to handle every conversation.</p>
      <p style="margin:0;font-size:14px;color:#8f89a0;">Talk soon,<br><strong style="color:#1d1a26;">The GOTCHA. Team</strong></p>`,
    footerNote: "You're receiving this because your workspace was activated on gotcha.co.il",
  });
}

// ─── Waitlist Welcome Email ──────────────────────────────────

export function waitlistWelcomeHtml(firstName: string, position: number): string {
  const socials: Array<[string, string, string]> = [
    ["https://www.facebook.com/gotchainbox", "https://cdn-icons-png.flaticon.com/512/733/733547.png", "Facebook"],
    ["https://www.instagram.com/gotcha.inbox/", "https://cdn-icons-png.flaticon.com/512/733/733558.png", "Instagram"],
    ["http://linkedin.com/in/omer-serruya", "https://cdn-icons-png.flaticon.com/512/733/733561.png", "LinkedIn"],
    ["https://www.linkedin.com/in/matan-amran-82625b264/", "https://cdn-icons-png.flaticon.com/512/733/733561.png", "LinkedIn"],
  ];
  const social = `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
        <tr><td align="center" style="padding:22px 16px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            ${socials.map(([href, img, alt]) => `<td style="padding:0 8px;"><a href="${href}" target="_blank" style="display:inline-block;width:36px;height:36px;border-radius:50%;background-color:#ffffff;border:1px solid #eae7f2;text-align:center;line-height:34px;text-decoration:none;"><img src="${img}" alt="${alt}" width="16" height="16" style="display:inline-block;vertical-align:middle;border:0;filter:brightness(0);opacity:0.45;" /></a></td>`).join("")}
          </tr></table>
          <p style="margin:10px 0 0;font-size:11px;color:#8f89a0;">Follow us &amp; DM the founders</p>
        </td></tr>
      </table>`;
  return renderBrandEmail({
    title: "You're in - GOTCHA.",
    preheader: "Welcome to early access - here's what happens next.",
    eyebrow: "Early access",
    icon: "&#10003;",
    headline: `You're in, ${escapeHtml(firstName)}.`,
    subhead: "Welcome to the inner circle.",
    bodyHtml:
      emailBadge("Your position", `#${position}`) +
      emailParagraph(`You just secured early access to <strong style="color:#1d1a26;">GOTCHA.</strong> &mdash; AI employees in one unified inbox (WhatsApp, Messenger &amp; Instagram) that actually help your team close faster.`) +
      emailSteps("What happens next", [
        { marker: "1", title: "We're building your command center", desc: "Our team is preparing the platform tailored to your business &mdash; every detail dialed in before you touch it." },
        { marker: "2", title: "A personal kickoff call", desc: "One of our specialists will reach out to schedule a call &mdash; we'll map your workflows and set you up for success." },
        { marker: "&#10003;", title: "Welcome to the GOTCHA standard", desc: "Every message answered. Every customer delighted. Starting day one." },
      ]) +
      emailPills("What you'll unlock", [
        "Unified inbox &mdash; WhatsApp, Messenger, Instagram",
        "An AI employee trained on your business",
        "Smart routing &amp; SLA tracking",
        "Visual bot builder &mdash; no code needed",
      ]),
    belowCardHtml: social,
    closingHtml: `<p style="margin:0 0 14px;font-size:14px;color:#8f89a0;line-height:1.6;">Got questions before your invite arrives?<br>Just hit reply &mdash; a real human reads every message.</p>
      <p style="margin:0;font-size:14px;color:#8f89a0;">Talk soon,<br><strong style="color:#1d1a26;">The GOTCHA. Team</strong></p>`,
    footerNote: "You're receiving this because you signed up at gotcha.co.il",
  });
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Send welcome email to new waitlist subscriber.
 */
export async function sendWaitlistWelcomeEmail(email: string, firstName: string, position: number): Promise<void> {
  const subject = `You're in, ${firstName} - welcome to Gotcha. early access`;
  const html = waitlistWelcomeHtml(firstName, position);
  const text = [
    `Hey ${firstName}!`,
    "",
    "Thanks for signing up for early access to Gotcha.",
    "",
    "What happens next:",
    "1. We're building your command center - preparing the platform tailored to your business",
    "2. A personal kickoff call - one of our team will reach out to schedule a Teams call",
    "3. Welcome to the Gotcha standard - transform how your company communicates, starting day one",
    "",
    "In the meantime, hit reply if you have any questions - we read every message.",
    "",
    "- The Gotcha. Team",
  ].join("\n");

  try {
    await sendHtmlEmail(email, subject, html, text);
    console.log(`[WAITLIST] Welcome email sent to ${email}`);
  } catch (err: any) {
    console.error(`[WAITLIST] Failed to send welcome email to ${email}:`, err.message);
  }
}

/**
 * Send onboarding email with magic link (no login required).
 */
export async function sendOnboardingEmail(
  tenantId: string,
  adminEmail: string,
  adminName: string,
  tenantName: string,
  tenantSlug: string,
  adminUserId: string,
): Promise<void> {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

  // One-time Authentik link: the admin sets their password there, then lands
  // back in GOTCHA authenticated. GOTCHA never issues the credential.
  const setupUrl = await createSetupLink(adminUserId);

  const subject = `Welcome to Gotcha. - Set up your ${tenantName} workspace`;
  const html = onboardingEmailHtml(adminName, tenantName, setupUrl);
  const text = [
    `Hello ${adminName},`,
    "",
    `Your organization "${tenantName}" has been created on Gotcha.`,
    "",
    "Click the link below to complete the setup wizard (no login required):",
    setupUrl,
    "",
    "This link expires in 48 hours.",
    "",
    "The setup wizard will guide you through:",
    "1. Setting up your business profile",
    "2. Configuring your departments",
    "3. Automatic AI agent configuration",
    "",
    "Best regards,",
    "The Gotcha. Team",
  ].join("\n");

  const payload: NotificationPayload = {
    tenantId,
    channel: "email",
    type: "onboarding_email",
    recipient: adminEmail,
    subject,
    body: text,
    metadata: { tenantSlug, setupUrl },
  };

  try {
    await sendHtmlEmail(adminEmail, subject, html, text);
    await logNotification(payload, "sent");
  } catch (err: any) {
    console.error("Failed to send onboarding email:", err);
    await logNotification(payload, "failed", err.message);
  }
}

/**
 * Send a lifecycle NUDGE email - generic subject/body computed by the Nudge
 * Engine. Reuses the same transport + logging as every other email. Returns
 * true on success so the engine can mark the nudge SENT vs FAILED.
 */
export async function sendNudgeEmail(
  tenantId: string,
  recipient: string,
  subject: string,
  html: string,
  text: string,
  dedupeKey: string,
): Promise<boolean> {
  const payload: NotificationPayload = {
    tenantId,
    channel: "email",
    type: "lifecycle_nudge",
    recipient,
    subject,
    body: text,
    metadata: { dedupeKey },
  };
  // Fail loud when the transport is a stub - a nudge that wasn't really sent must
  // settle FAILED, never SENT. Otherwise the Voice reports it is speaking when
  // it is mute (T-4).
  if (!isEmailTransportConfigured()) {
    console.error(`[EMAIL] Nudge NOT delivered to ${recipient} - SMTP unconfigured (stub transport). Marking FAILED, not SENT.`);
    await logNotification(payload, "failed", "smtp_unconfigured").catch(() => {});
    return false;
  }
  try {
    await sendHtmlEmail(recipient, subject, html, text);
    await logNotification(payload, "sent");
    return true;
  } catch (err: any) {
    console.error("Failed to send nudge email:", err?.message);
    await logNotification(payload, "failed", err?.message);
    return false;
  }
}

/**
 * Send tenant activation confirmation after onboarding completes.
 */
export async function sendActivationConfirmation(tenantId: string): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: {
      businessProfile: true,
      departments: {
        where: { isActive: true },
      },
      users: {
        where: { role: "ADMIN", isActive: true },
        select: { email: true, name: true },
      },
    },
  });

  if (!tenant) return;

  const admin = tenant.users[0];
  if (!admin) return;

  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  const dashboardUrl = `${frontendUrl}/conversations`;

  const departments = tenant.departments.map((d) => {
    return {
      name: d.name,
      sla: d.slaTarget ? `${d.slaTarget} min` : "Not set",
    };
  });

  const subject = `${tenant.name} is now active on Gotcha.`;
  const html = activationEmailHtml(
    admin.name,
    tenant.name,
    tenant.businessProfile?.industry || "N/A",
    tenant.businessProfile?.businessPriority || "N/A",
    departments,
    dashboardUrl,
  );
  const text = [
    `Hello ${admin.name},`,
    "",
    `Your organization "${tenant.name}" has been fully activated on Gotcha.`,
    "",
    "Setup Summary:",
    `- Industry: ${tenant.businessProfile?.industry || "N/A"}`,
    `- Business Priority: ${tenant.businessProfile?.businessPriority || "N/A"}`,
    "",
    "Departments Configured:",
    ...departments.map((d) => `  - ${d.name} (SLA: ${d.sla})`),
    "",
    "Your AI agents have been automatically configured for each department.",
    "You can now start receiving and processing conversations.",
    "",
    `Open your dashboard: ${dashboardUrl}`,
    "",
    "Best regards,",
    "The Gotcha. Team",
  ].join("\n");

  const payload: NotificationPayload = {
    tenantId,
    channel: "email",
    type: "activation_confirmation",
    recipient: admin.email,
    subject,
    body: text,
    metadata: {
      departmentCount: tenant.departments.length,
    },
  };

  try {
    await sendHtmlEmail(admin.email, subject, html, text);
    await logNotification(payload, "sent");

    await publishEvent({
      event: "tenant:activated",
      tenantId,
      data: {
        tenantName: tenant.name,
        departmentCount: tenant.departments.length,
      },
    });
  } catch (err: any) {
    console.error("Failed to send activation confirmation:", err);
    await logNotification(payload, "failed", err.message);
  }
}

// ─── Teammate Invite (Onboarding v2 "Invite your team") ─────
//
// Fires from POST /api/onboarding/invite-team. The link drops the
// teammate straight into the workspace via the existing magic-link
// verifier - no separate signup form for the email-targeted flow.

interface TeammateInviteArgs {
  email: string;
  tenantName: string;
  tenantSlug: string;
  inviterName: string;
  setupUrl: string;
}

function teammateInviteHtml(args: TeammateInviteArgs, joinUrl: string): string {
  return renderBrandEmail({
    title: `${escapeHtml(args.inviterName)} invited you to ${escapeHtml(args.tenantName)}`,
    preheader: `${args.inviterName} wants you on the team.`,
    eyebrow: "Team invite",
    icon: "&#128075;",
    headline: `You're invited to ${escapeHtml(args.tenantName)}.`,
    subhead: `${escapeHtml(args.inviterName)} wants you on the team.`,
    cta: { label: "Accept &amp; open workspace", url: joinUrl },
    fallbackUrl: joinUrl,
    expiryNote: "The link is valid for 48 hours. If you didn't expect this invite you can ignore this email.",
  });
}

export async function sendTeammateInvite(args: TeammateInviteArgs): Promise<void> {
  // Authentik-issued one-time link: the teammate sets their own password there
  // and arrives back in GOTCHA authenticated.
  const joinUrl = args.setupUrl;
  const subject = `${args.inviterName} invited you to ${args.tenantName}`;
  const text = `${args.inviterName} invited you to join ${args.tenantName} on GOTCHA.\n\nAccept your invite: ${joinUrl}\n\nThis link is valid for 48 hours.`;
  const html = teammateInviteHtml(args, joinUrl);

  // Resolve tenantId by slug so logNotification has the right scope.
  let tenantIdForLog = "";
  try {
    const t = await prisma.tenant.findUnique({ where: { slug: args.tenantSlug }, select: { id: true } });
    tenantIdForLog = t?.id || "";
  } catch { /* best-effort logging only */ }

  const payload: NotificationPayload = {
    tenantId: tenantIdForLog,
    channel: "email",
    type: "teammate_invite",
    recipient: args.email,
    subject,
    body: text,
    metadata: { tenantSlug: args.tenantSlug, inviterName: args.inviterName },
  };

  try {
    await sendHtmlEmail(args.email, subject, html, text);
    if (tenantIdForLog) await logNotification(payload, "sent");
  } catch (err: any) {
    console.error("Failed to send teammate invite:", err);
    if (tenantIdForLog) await logNotification(payload, "failed", err.message);
    throw err;
  }
}

// Older import alias kept for the existing onboarding route (it
// imports `sendOnboardingInvite` even though we only need
// `sendTeammateInvite`). Re-export so the import line stays minimal.
export const sendOnboardingInvite = sendTeammateInvite;

// ── "Tell us about an integration we don't have yet" ────────────────────────
// During onboarding the scan sometimes spots an important tool GOTCHA doesn't
// support yet (a ReturnGO-style app). The owner can flag it with one click; we
// email the team so we know what to build next. Destination is env-driven
// (MAIL_TO / INTEGRATION_REQUEST_EMAIL) - a future group alias - and it degrades
// gracefully (logs, never throws) when SMTP or the address isn't configured.
export interface IntegrationRequestArgs {
  integration: string;              // the tool/integration name the owner wants
  tenantId?: string;
  tenantName?: string;
  requestedByEmail?: string;
  requestedByName?: string;
  websiteDomain?: string;
  note?: string;                    // optional free-text context from the owner
  source?: string;                  // where it was flagged (e.g. "onboarding_integrations")
}

export function integrationRequestRecipient(): string | null {
  return (process.env.MAIL_TO || process.env.INTEGRATION_REQUEST_EMAIL || process.env.TEAM_ALERT_EMAIL || "").trim() || null;
}

export async function sendIntegrationRequestEmail(args: IntegrationRequestArgs): Promise<boolean> {
  const to = integrationRequestRecipient();
  if (!to) {
    console.warn("[notify] integration request not sent - no MAIL_TO / INTEGRATION_REQUEST_EMAIL configured:", args.integration);
    return false;
  }
  if (!isEmailTransportConfigured()) {
    console.warn("[notify] integration request not sent - SMTP not configured:", args.integration);
    return false;
  }
  const subject = `Integration request: ${args.integration}`;
  const rows = [
    ["Integration", args.integration],
    ["Business", args.tenantName || "-"],
    ["Website", args.websiteDomain || "-"],
    ["Requested by", [args.requestedByName, args.requestedByEmail].filter(Boolean).join(" · ") || "-"],
    ["Tenant ID", args.tenantId || "-"],
    ["Source", args.source || "onboarding"],
    ["Note", args.note || "-"],
  ];
  const bodyHtml = rows
    .map(([k, v]) => `${emailParagraph(`<strong>${escapeHtml(String(k))}:</strong> ${escapeHtml(String(v))}`)}`)
    .join("");
  const html = renderBrandEmail({
    title: subject,
    eyebrow: "Integration request",
    icon: "🔌",
    headline: `A customer wants ${escapeHtml(args.integration)}`,
    subhead: "Flagged during onboarding - a tool we don't support yet.",
    bodyHtml,
    footerNote: "You're receiving this because you're on the GOTCHA integrations alias.",
  });
  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  try {
    await sendHtmlEmail(to, subject, html, text);
    return true;
  } catch (err: any) {
    console.error("[notify] failed to send integration request email:", err?.message);
    return false;
  }
}

// ─── Email Change Verification ──────────────────────────────

/**
 * Send the verification link for a self-service email change to the NEW address.
 * Proving control of the new inbox is what authorizes the change. Branded with
 * renderBrandEmail so it never looks like a stock IdP email.
 */
export async function sendEmailChangeVerification(
  newEmail: string,
  name: string,
  verifyUrl: string,
): Promise<void> {
  const subject = "Confirm your new email - GOTCHA";
  const text =
    `Hi ${name},\n\nConfirm this address to make it your new GOTCHA sign-in email:\n${verifyUrl}\n\n` +
    `This link expires in 1 hour. If you didn't request this, you can ignore this email.`;
  const html = renderBrandEmail({
    title: "Confirm your new email - GOTCHA.",
    preheader: "Confirm this address to finish changing your email.",
    eyebrow: "Verify your email",
    icon: "&#9993;",
    headline: "Confirm your new email",
    subhead: `${escapeHtml(name)}, confirm this address to make it your new GOTCHA sign-in email.`,
    cta: { label: "Confirm email", url: verifyUrl },
    fallbackUrl: verifyUrl,
    expiryNote: `This link expires in <strong style="color:#7C3291;">1 hour</strong>`,
    footerNote: "You're receiving this because someone requested to use this address on gotcha.co.il. If that wasn't you, ignore this email.",
  });
  await sendHtmlEmail(newEmail, subject, html, text);
}

// ─── Team Invitation ────────────────────────────────────────

/**
 * Send the invitee their one-time password-setup link. The admin still sees
 * the link in the UI as a fallback, but the invitee should not depend on a
 * copy-paste hand-off: the invite lands in their inbox like any SaaS invite.
 */
export async function sendTeamInviteEmail(
  email: string,
  name: string,
  workspaceName: string,
  setupLink: string,
): Promise<void> {
  const subject = `You've been invited to ${workspaceName} on GOTCHA`;
  const text =
    `Hi ${name},\n\nYou've been invited to join ${workspaceName} on GOTCHA.\n` +
    `Set your password to activate your account:\n${setupLink}\n\n` +
    `The link can be used once. If you weren't expecting this invite, you can ignore this email.`;
  const html = renderBrandEmail({
    title: `Join ${workspaceName} on GOTCHA.`,
    preheader: `Set your password to join ${workspaceName}.`,
    eyebrow: "Team invitation",
    icon: "&#128075;",
    headline: `Join ${escapeHtml(workspaceName)}`,
    subhead: `${escapeHtml(name)}, you've been invited to join <strong>${escapeHtml(workspaceName)}</strong> on GOTCHA. Set your password and you're in.`,
    cta: { label: "Set your password", url: setupLink },
    fallbackUrl: setupLink,
    expiryNote: `This link can be used <strong style="color:#7C3291;">once</strong>.`,
    footerNote: `You're receiving this because an administrator of ${escapeHtml(workspaceName)} invited this address. If that wasn't expected, ignore this email.`,
  });
  await sendHtmlEmail(email, subject, html, text);
}
