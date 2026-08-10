import crypto from "crypto";
import nodemailer from "nodemailer";
import {
  prisma,
  publishEvent,
  resolveAppPublicUrl,
  renderBrandEmail,
  escapeHtml,
  emailParagraph,
  emailSteps,
  emailStatCards,
  emailKeyValueTable,
  emailBadge,
  emailPills,
  EMAIL_COLORS as EC,
} from "@chatcenter/shared";
import { issueSetupLink } from "./setup-link.service";

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

/**
 * Strip credential-bearing URLs out of the copy we PERSIST.
 *
 * `notification_logs.body` is a full-text copy of what was mailed, kept so
 * support can answer "what exactly did they receive". That is worth having, but
 * a setup link is a bearer credential: anyone who can read the row can set that
 * person's password until it expires. The email keeps the link, the log does
 * not.
 */
function withoutCredentialUrls(text: string, ...urls: (string | null | undefined)[]): string {
  return urls
    .filter((u): u is string => !!u)
    .reduce((acc, u) => acc.split(u).join("[link removed from log]"), text);
}

async function sendHtmlEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@gotcha.app";
  const mail = getTransporter();
  await mail.sendMail({ from, to, subject, html, text });
  console.log(`[EMAIL] Sent to: ${to} | Subject: ${subject}`);
}

// ─── Setup / Sign-in Links ──────────────────────────────────

/**
 * The link that drops a user into Authentik to set their password.
 *
 * GOTCHA still mints no credential: the thing this returns is a pointer to
 * `GET /api/auth/setup/:token`, which mints the Authentik recovery link at the
 * moment the person clicks and redirects them into Authentik's own flow.
 *
 * The indirection is not decoration. Authentik's recovery FlowToken inherits
 * `default_token_duration` (30 minutes), and mailing that token directly meant
 * the clock started when the mail was SENT: a customer who opened their
 * invitation an hour later met a password form that refused after they had
 * already typed a password. See setup-link.service.ts for the full story.
 */
export async function createSetupLink(userId: string): Promise<string> {
  const { url } = await issueSetupLink(userId);
  return url;
}

/**
 * Mail a fresh setup link to someone whose previous one expired.
 *
 * Deliberately terse and self-contained: the recipient already knows what
 * GOTCHA is (they were invited), and the only thing they asked for is a link
 * that works. Issuing revokes the dead one, so there is never more than one
 * live link per person.
 */
export async function sendSetupLinkEmail(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, tenantId: true, tenant: { select: { name: true } } },
  });
  if (!user) throw new Error("User not found");

  const { url } = await issueSetupLink(userId);
  const tenantName = user.tenant?.name ?? "your workspace";
  const subject = "Your new GOTCHA setup link";
  const html = renderBrandEmail({
    title: "Set your password - GOTCHA.",
    preheader: "Here is a fresh link. This one is good for 48 hours.",
    eyebrow: "New link",
    icon: "&#128273;",
    headline: "Here is a fresh link.",
    subhead: `${escapeHtml(user.name)}, set your password and you are into ${escapeHtml(tenantName)}.`,
    bodyHtml: emailParagraph(
      "The previous link had expired. Nothing is wrong with your account and nothing was lost.",
    ),
    cta: { label: "Set my password", url },
    fallbackUrl: url,
    expiryNote: `This link expires in <strong style="color:#7C3291;">48 hours</strong>`,
    footerNote: "You're receiving this because you asked for a new setup link.",
  });
  const text = [
    `Hello ${user.name},`,
    "",
    "Here is a fresh link to set your password:",
    url,
    "",
    "This link expires in 48 hours.",
    "",
    "The Gotcha. Team",
  ].join("\n");

  const payload: NotificationPayload = {
    tenantId: user.tenantId,
    channel: "email",
    type: "setup_link_resend",
    recipient: user.email,
    subject,
    body: withoutCredentialUrls(text, url),
    // The raw token is NOT recorded here. The onboarding email logs its
    // setupUrl, which is how the 2026-08-06 incident was reconstructed, but
    // that URL was already dead by then. A live 48-hour token in a log row is
    // a different thing entirely.
    metadata: {},
  };

  try {
    await sendHtmlEmail(user.email, subject, html, text);
    await logNotification(payload, "sent");
  } catch (err: any) {
    console.error("Failed to send setup link email:", err);
    await logNotification(payload, "failed", err.message);
    throw err;
  }
}

/**
 * Where to send someone who just needs to log in (nudge emails, "come back"
 * links). There is no token to embed: the app bounces them to Authentik, and
 * if they still have a session they land straight in the workspace.
 */
export function signInUrl(): string {
  return resolveAppPublicUrl(process.env);
}

// ─── Brand Email System ─────────────────────────────────────
//
// The shell and its row builders moved to `@chatcenter/shared`. The receipt is
// now sent by us rather than by the payment provider, so billing renders mail
// too - and a design system that lives inside one service is a design system
// the next service will quietly fork. Re-exported here because the Nudge
// Engine and every template below import them from this module.

export {
  renderBrandEmail,
  escapeHtml,
  emailParagraph,
  type BrandEmailArgs,
} from "@chatcenter/shared";

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
  const frontendUrl = resolveAppPublicUrl(process.env);

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
    body: withoutCredentialUrls(text, setupUrl),
    // The setup URL is NOT recorded. It used to be, and that is how the
    // 2026-08-06 incident was reconstructed - but back then the token in it was
    // already dead 30 minutes after sending. It now stays live for 48 hours,
    // and a live credential does not belong in a queryable log row.
    metadata: { tenantSlug },
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

  const frontendUrl = resolveAppPublicUrl(process.env);
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
    `The link is good for 48 hours. If you weren't expecting this invite, you can ignore this email.`;
  const html = renderBrandEmail({
    title: `Join ${workspaceName} on GOTCHA.`,
    preheader: `Set your password to join ${workspaceName}.`,
    eyebrow: "Team invitation",
    icon: "&#128075;",
    headline: `Join ${escapeHtml(workspaceName)}`,
    subhead: `${escapeHtml(name)}, you've been invited to join <strong>${escapeHtml(workspaceName)}</strong> on GOTCHA. Set your password and you're in.`,
    cta: { label: "Set your password", url: setupLink },
    fallbackUrl: setupLink,
    // Accurate as of the GOTCHA-owned setup link: valid for 48 hours and
    // usable more than once inside that window. It said "once" while the link
    // was Authentik's, which was true of the IdP token but not of the window
    // the recipient actually had.
    expiryNote: `This link is good for <strong style="color:#7C3291;">48 hours</strong>.`,
    footerNote: `You're receiving this because an administrator of ${escapeHtml(workspaceName)} invited this address. If that wasn't expected, ignore this email.`,
  });
  await sendHtmlEmail(email, subject, html, text);
}

/**
 * Paid-tenant onboarding email.
 *
 * Rendered entirely from the IMMUTABLE commercial snapshot passed in by the
 * caller. It never reads the live Plan row: if pricing changes between issuing
 * an offer and the customer opening the email, they must still see the terms
 * they were actually offered.
 *
 * Carries no internal identifier of any kind - no tenant id, checkout id,
 * attempt id, plan id or provider detail - and no card or token vocabulary. The
 * only opaque value is the continuation token, which is the whole point of the
 * link.
 */
export function paidOnboardingEmailHtml(a: {
  adminName: string;
  tenantName: string;
  planName: string;
  amount: string;
  currency: string;
  includedCredits: number;
  continuationUrl: string;
  /**
   * One-time Authentik link where the admin sets their password FIRST.
   *
   * When present it is the primary call to action, and paying happens inside
   * the app afterwards as an authenticated user. That ordering is what closes
   * the credential gap: previously the payment link was the only thing in this
   * email, so a customer bought the product without ever authenticating and
   * then met a sign-in wall for a password nobody had set.
   *
   * Null when the admin already has a password, in which case there is nothing
   * to set and the payment link leads.
   */
  setupUrl?: string | null;
  expiresAtLabel: string;
  locale?: string;
}): string {
  const he = a.locale === "he";
  const symbol = a.currency === "ILS" ? "₪" : "$";
  const price = `${symbol}${Number(a.amount).toLocaleString("en-US")}`;
  const credits = a.includedCredits.toLocaleString("en-US");

  return renderBrandEmail({
    locale: a.locale,
    title: he ? `הגדרת ${escapeHtml(a.tenantName)} - GOTCHA.` : `Set up ${escapeHtml(a.tenantName)} - GOTCHA.`,
    preheader: he
      ? "הארגון שלכם נוצר. השלימו הגדרה ותשלום כדי להפעיל את התוכנית."
      : "Your organization has been created. Complete setup and payment to activate your plan.",
    eyebrow: he ? "הארגון שלכם נוצר" : "Your organization is ready",
    icon: "&#9889;",
    headline: he ? `נגדיר את ${escapeHtml(a.tenantName)}.` : `Let's set up ${escapeHtml(a.tenantName)}.`,
    subhead: he
      ? `${escapeHtml(a.adminName)}, הארגון שלכם נוצר. השלימו את ההגדרה והתשלום כדי להפעיל את התוכנית שנבחרה.`
      : `${escapeHtml(a.adminName)}, your organization has been created. Complete account setup and payment to activate the selected plan.`,
    bodyHtml: emailSteps(he ? "התוכנית שנבחרה" : "Your selected plan", [
      { marker: "1", title: escapeHtml(a.planName), desc: he ? `${price} לחודש` : `${price} per month` },
      { marker: "2", title: he ? `${credits} קרדיטים` : `${credits} credits`, desc: he ? "כלולים בכל חודש" : "included every month" },
      {
        marker: "&#10003;",
        title: he ? "הפעלה לאחר אישור התשלום" : "Activates after payment is confirmed",
        desc: he
          ? "אפשר להשלים את הגדרת המשתמש כבר עכשיו."
          : "You can complete account setup right away.",
      },
    ]),
    // Password first, payment second. Following the button leaves them signed
    // in, and the app itself walks them to the payment screen, so they pay as
    // somebody we can identify rather than as whoever opened a link.
    //
    // The payment link stays below as a secondary path on purpose: forwarding
    // this email to whoever settles invoices is normal and useful, and that
    // person can pay without being handed the admin's account. Only the button
    // above establishes a credential, and only this mailbox received it.
    cta: a.setupUrl
      ? { label: he ? "הגדרת החשבון" : "Set up your account", url: a.setupUrl }
      : { label: he ? "השלמת ההגדרה" : "Complete setup", url: a.continuationUrl },
    belowCardHtml: a.setupUrl
      ? `<p style="margin:0;font-size:13px;color:${EC.muted};line-height:1.7;text-align:${he ? "right" : "left"};">${
          he
            ? `משלמים בלי להיכנס למערכת? <a href="${a.continuationUrl}" style="color:${EC.strong};font-weight:600;">מסך התשלום</a>`
            : `Paying without signing in? <a href="${a.continuationUrl}" style="color:${EC.strong};font-weight:600;">Go to the payment page</a>`
        }</p>`
      : undefined,
    fallbackUrl: a.setupUrl ?? a.continuationUrl,
    expiryNote: he
      ? `הקישור בתוקף עד <strong style="color:#7C3291;">${escapeHtml(a.expiresAtLabel)}</strong>`
      : `This link is valid until <strong style="color:#7C3291;">${escapeHtml(a.expiresAtLabel)}</strong>`,
    footerNote: he
      ? "קיבלתם את ההודעה הזו כי נוצר עבורכם ארגון ב-gotcha.co.il"
      : "You're receiving this because your organization was created on gotcha.co.il",
  });
}

export async function sendPaidOnboardingEmail(a: {
  tenantId: string;
  adminEmail: string;
  adminName: string;
  tenantName: string;
  adminUserId: string;
  continuationToken: string;
  /**
   * The checkout this link is for. Required: the token authorizes action on a
   * checkout the caller already names, so a link carrying only the token
   * lands on a page with nothing to ask about.
   */
  checkoutReference: string;
  linkExpiresAt: Date;
  planName: string;
  amount: string;
  currency: string;
  includedCredits: number;
  /** See `paidOnboardingEmailHtml`: password first, payment second. */
  setupUrl?: string | null;
  locale?: string;
  resend?: boolean;
}): Promise<void> {
  const frontendUrl = resolveAppPublicUrl(process.env);
  // Both parts are needed, and they do different jobs: `ref` says WHICH
  // checkout, `token` proves the holder may act on it. The entry page strips
  // the token out of the address bar on arrival.
  const continuationUrl =
    `${frontendUrl}/checkout` +
    `?ref=${encodeURIComponent(a.checkoutReference)}` +
    `&token=${encodeURIComponent(a.continuationToken)}`;
  const he = a.locale === "he";
  const expiresAtLabel = a.linkExpiresAt.toISOString().slice(0, 16).replace("T", " ");

  const subject = he
    ? `הגדרת ${a.tenantName} ותשלום - GOTCHA.`
    : `Set up ${a.tenantName} and complete payment - GOTCHA.`;

  const html = paidOnboardingEmailHtml({ ...a, continuationUrl, expiresAtLabel });
  const symbol = a.currency === "ILS" ? "₪" : "$";
  const text = he
    ? [
        `שלום ${a.adminName},`, "",
        `הארגון "${a.tenantName}" נוצר ב-GOTCHA.`, "",
        `התוכנית שנבחרה: ${a.planName}`,
        `מחיר: ${symbol}${Number(a.amount).toLocaleString("en-US")} לחודש`,
        `קרדיטים כלולים: ${a.includedCredits.toLocaleString("en-US")}`, "",
        ...(a.setupUrl
          ? ["התחילו בהגדרת החשבון ובחירת סיסמה:", a.setupUrl, "",
             "משלמים בלי להיכנס למערכת? מסך התשלום:", continuationUrl]
          : ["השלימו את ההגדרה והתשלום כדי להפעיל את התוכנית:", continuationUrl]),
        "",
        `הקישור בתוקף עד ${expiresAtLabel}.`, "",
        "החשבון יופעל במלואו לאחר אישור התשלום.", "",
        "צוות GOTCHA.",
      ].join("\n")
    : [
        `Hello ${a.adminName},`, "",
        `Your organization "${a.tenantName}" has been created on GOTCHA.`, "",
        `Selected plan: ${a.planName}`,
        `Price: ${symbol}${Number(a.amount).toLocaleString("en-US")} per month`,
        `Included credits: ${a.includedCredits.toLocaleString("en-US")}`, "",
        ...(a.setupUrl
          ? ["Set up your account and choose a password:", a.setupUrl, "",
             "Paying without signing in? Go to the payment page:", continuationUrl]
          : ["Complete account setup and payment to activate the plan:", continuationUrl]),
        "",
        `This link is valid until ${expiresAtLabel}.`, "",
        "Your account becomes fully active once payment is confirmed.", "",
        "The GOTCHA. Team",
      ].join("\n");

  const payload: NotificationPayload = {
    tenantId: a.tenantId,
    channel: "email",
    type: a.resend ? "paid_onboarding_email_resent" : "paid_onboarding_email",
    recipient: a.adminEmail,
    subject,
    body: text,
    // The continuation URL carries the raw token, so it is deliberately NOT
    // recorded in notification metadata.
    metadata: { planName: a.planName, expiresAt: a.linkExpiresAt.toISOString() },
  };

  try {
    await sendHtmlEmail(a.adminEmail, subject, html, text);
    await logNotification(payload, "sent");
  } catch (err: any) {
    // Delivery failure activates nothing. Resend is the repair path.
    console.error("Failed to send paid onboarding email:", err?.message ?? err);
    await logNotification(payload, "failed", err.message);
    throw err;
  }
}

/**
 * "Payment confirmed, now let's set you up."
 *
 * The paid signup order is pay FIRST, configure second, and the payment link
 * authorizes a checkout rather than a person - so a customer can complete the
 * whole purchase without ever authenticating. That left the admin at a sign-in
 * wall asking for a password nobody had ever set.
 *
 * This is the email that closes that gap: it is the only place the credential
 * link is handed out, because delivery to the registered address is what
 * proves the recipient. The payment link deliberately cannot mint one - it is
 * routinely forwarded to whoever settles invoices, and that person must not be
 * able to take over the admin account.
 */
export function paymentSucceededEmailHtml(a: {
  adminName: string;
  tenantName: string;
  planName: string;
  includedCredits: number;
  actionUrl: string;
  /** False when the admin already has a password and only needs the way in. */
  needsPassword: boolean;
  locale?: string;
}): string {
  const he = a.locale === "he";
  const credits = a.includedCredits.toLocaleString("en-US");

  const steps = [
    ...(a.needsPassword
      ? [{
          marker: "1",
          title: he ? "בחרו סיסמה" : "Choose your password",
          desc: he ? "פעם אחת, ואתם בפנים." : "Once, and you're in.",
        }]
      : []),
    {
      marker: a.needsPassword ? "2" : "1",
      title: he ? "ספרו לנו על העסק" : "Tell us about your business",
      desc: he
        ? "כמה שאלות, וצוות ה-AI שלכם מוכן לעבודה."
        : "A few questions, and your AI team is ready to work.",
    },
    {
      marker: "&#10003;",
      title: he ? `${credits} קרדיטים` : `${credits} credits`,
      desc: he ? "כלולים בכל חודש, כבר בחשבון." : "included every month, already in your account.",
    },
  ];

  return renderBrandEmail({
    locale: a.locale,
    title: he ? `התשלום אושר - GOTCHA.` : `Payment confirmed - GOTCHA.`,
    preheader: he
      ? "התשלום התקבל. נשאר רק להגדיר את החשבון."
      : "Payment received. All that's left is setting up your account.",
    eyebrow: he ? "התשלום אושר" : "Payment confirmed",
    icon: "&#127881;",
    headline: he ? `${escapeHtml(a.tenantName)} מוכן לצאת לדרך.` : `${escapeHtml(a.tenantName)} is ready to go.`,
    subhead: he
      ? `${escapeHtml(a.adminName)}, התשלום התקבל והתוכנית ${escapeHtml(a.planName)} פעילה. נשאר צעד אחד קצר.`
      : `${escapeHtml(a.adminName)}, your payment went through and ${escapeHtml(a.planName)} is live. One short step left.`,
    bodyHtml: emailSteps(he ? "מה עכשיו" : "What happens now", steps),
    cta: {
      label: a.needsPassword
        ? (he ? "הגדרת סיסמה והתחלה" : "Set your password and start")
        : (he ? "התחלת ההגדרה" : "Start setup"),
      url: a.actionUrl,
    },
    fallbackUrl: a.actionUrl,
    footerNote: he
      ? "קיבלתם את ההודעה הזו כי השלמתם תשלום ב-gotcha.co.il"
      : "You're receiving this because you completed a payment on gotcha.co.il",
  });
}

export async function sendPaymentSucceededEmail(a: {
  tenantId: string;
  adminEmail: string;
  adminName: string;
  tenantName: string;
  planName: string;
  includedCredits: number;
  actionUrl: string;
  needsPassword: boolean;
  locale?: string;
  resend?: boolean;
}): Promise<void> {
  const he = a.locale === "he";
  const subject = he
    ? `התשלום אושר. נגדיר את ${a.tenantName} - GOTCHA.`
    : `Payment confirmed. Let's set up ${a.tenantName} - GOTCHA.`;

  const html = paymentSucceededEmailHtml(a);
  const text = he
    ? [
        `שלום ${a.adminName},`, "",
        `התשלום התקבל והתוכנית ${a.planName} פעילה.`,
        `${a.includedCredits.toLocaleString("en-US")} קרדיטים כבר בחשבון.`, "",
        a.needsPassword
          ? "בחרו סיסמה והתחילו בהגדרת החשבון:"
          : "התחילו בהגדרת החשבון:",
        a.actionUrl, "",
        "צוות GOTCHA.",
      ].join("\n")
    : [
        `Hello ${a.adminName},`, "",
        `Your payment went through and ${a.planName} is live.`,
        `${a.includedCredits.toLocaleString("en-US")} credits are already in your account.`, "",
        a.needsPassword
          ? "Choose a password and start setting up your account:"
          : "Start setting up your account:",
        a.actionUrl, "",
        "The GOTCHA. Team",
      ].join("\n");

  const payload: NotificationPayload = {
    tenantId: a.tenantId,
    channel: "email",
    type: a.resend ? "payment_succeeded_email_resent" : "payment_succeeded_email",
    recipient: a.adminEmail,
    subject,
    body: text,
    // The action URL may be a one-time credential link, so it is deliberately
    // NOT recorded in notification metadata.
    metadata: { planName: a.planName, needsPassword: a.needsPassword },
  };

  try {
    await sendHtmlEmail(a.adminEmail, subject, html, text);
    await logNotification(payload, "sent");
  } catch (err: any) {
    // The money is already settled; a failed email is a resend, not a rollback.
    console.error("Failed to send payment succeeded email:", err?.message ?? err);
    await logNotification(payload, "failed", err.message);
    throw err;
  }
}
