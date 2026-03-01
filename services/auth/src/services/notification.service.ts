import crypto from "crypto";
import nodemailer from "nodemailer";
import { prisma, publishEvent } from "@chatcenter/shared";

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

// ─── Magic Link Token Generation ────────────────────────────

const MAGIC_LINK_EXPIRY_HOURS = 48;

export async function createMagicLink(tenantId: string, userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_HOURS * 60 * 60 * 1000);

  await prisma.magicLink.create({
    data: { token, tenantId, userId, expiresAt },
  });

  return token;
}

// ─── HTML Email Templates ───────────────────────────────────

function emailWrapper(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gotcha.</title>
  <!--[if mso]>
  <style>table,td{font-family:Arial,sans-serif;}</style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f8f9fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8f9fb;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">

          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <span style="font-size:28px;font-weight:800;color:#111827;letter-spacing:-0.5px;">Gotcha.</span>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#ffffff;border-radius:16px;border:1px solid #e5e7eb;overflow:hidden;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${content}
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding:24px 16px 0;">
              <p style="margin:0;color:#9ca3af;font-size:12px;line-height:18px;">
                Sent by Gotcha. &mdash; Smart messaging for modern teams.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function onboardingEmailHtml(adminName: string, tenantName: string, setupUrl: string): string {
  return emailWrapper(`
                <!-- Header -->
                <tr>
                  <td style="padding:36px 36px 28px;border-bottom:1px solid #f3f4f6;">
                    <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:0.5px;">Welcome aboard</p>
                    <h1 style="margin:0 0 12px;font-size:24px;font-weight:700;color:#111827;line-height:1.3;">
                      Set up your workspace
                    </h1>
                    <p style="margin:0;font-size:15px;color:#6b7280;line-height:1.6;">
                      Hello <strong style="color:#374151;">${adminName}</strong>, your organization <strong style="color:#374151;">"${tenantName}"</strong> has been created. Complete the setup wizard to get started.
                    </p>
                  </td>
                </tr>

                <!-- CTA Button -->
                <tr>
                  <td style="padding:28px 36px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center">
                          <a href="${setupUrl}" target="_blank" style="display:inline-block;background-color:#6366f1;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:10px;mso-padding-alt:12px 32px;">
                            Start Setup Wizard &rarr;
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Steps -->
                <tr>
                  <td style="padding:0 36px 32px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f9fafb;border-radius:12px;">
                      <tr>
                        <td style="padding:20px 24px 8px;">
                          <p style="margin:0;font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.8px;">What you'll do</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:12px 24px;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <td style="width:28px;vertical-align:top;padding-right:12px;">
                                <div style="width:24px;height:24px;background-color:#6366f1;border-radius:50%;text-align:center;line-height:24px;color:#fff;font-size:12px;font-weight:700;">1</div>
                              </td>
                              <td style="vertical-align:top;padding-bottom:14px;">
                                <p style="margin:0;font-size:14px;font-weight:600;color:#374151;">Business Profile</p>
                                <p style="margin:2px 0 0;font-size:13px;color:#9ca3af;">Industry, priorities, and preferences</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:0 24px;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <td style="width:28px;vertical-align:top;padding-right:12px;">
                                <div style="width:24px;height:24px;background-color:#6366f1;border-radius:50%;text-align:center;line-height:24px;color:#fff;font-size:12px;font-weight:700;">2</div>
                              </td>
                              <td style="vertical-align:top;padding-bottom:14px;">
                                <p style="margin:0;font-size:14px;font-weight:600;color:#374151;">Departments</p>
                                <p style="margin:2px 0 0;font-size:13px;color:#9ca3af;">Teams, SLAs, and automation rules</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:0 24px 20px;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <td style="width:28px;vertical-align:top;padding-right:12px;">
                                <div style="width:24px;height:24px;background-color:#10b981;border-radius:50%;text-align:center;line-height:24px;color:#fff;font-size:12px;font-weight:700;">&#10003;</div>
                              </td>
                              <td style="vertical-align:top;">
                                <p style="margin:0;font-size:14px;font-weight:600;color:#374151;">AI Agents</p>
                                <p style="margin:2px 0 0;font-size:13px;color:#9ca3af;">Auto-configured for each department</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Fallback link -->
                <tr>
                  <td style="padding:0 36px 28px;">
                    <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
                      Button not working? Copy this link:<br>
                      <a href="${setupUrl}" style="color:#6366f1;word-break:break-all;font-size:12px;">${setupUrl}</a>
                    </p>
                    <p style="margin:8px 0 0;font-size:12px;color:#d1d5db;">
                      This link expires in 48 hours &bull; No login required
                    </p>
                  </td>
                </tr>
  `);
}

function activationEmailHtml(
  adminName: string,
  tenantName: string,
  industry: string,
  priority: string,
  departments: { name: string; sla: string }[],
  dashboardUrl: string,
): string {
  const deptRows = departments
    .map(
      (d) => `
                            <tr>
                              <td style="padding:10px 14px;border-bottom:1px solid #f3f4f6;font-size:14px;color:#374151;">${d.name}</td>
                              <td style="padding:10px 14px;border-bottom:1px solid #f3f4f6;text-align:center;font-size:14px;color:#6b7280;">${d.sla}</td>
                            </tr>`,
    )
    .join("");

  return emailWrapper(`
                <!-- Header -->
                <tr>
                  <td style="padding:36px 36px 24px;border-bottom:1px solid #f3f4f6;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="vertical-align:middle;padding-right:14px;">
                          <div style="width:40px;height:40px;background-color:#ecfdf5;border-radius:50%;text-align:center;line-height:40px;">
                            <span style="font-size:20px;color:#10b981;">&#10003;</span>
                          </div>
                        </td>
                        <td style="vertical-align:middle;">
                          <p style="margin:0 0 2px;font-size:14px;font-weight:600;color:#10b981;text-transform:uppercase;letter-spacing:0.5px;">You're live</p>
                          <h1 style="margin:0;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
                            ${tenantName} is now active
                          </h1>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Greeting -->
                <tr>
                  <td style="padding:24px 36px 0;">
                    <p style="margin:0;font-size:15px;color:#6b7280;line-height:1.6;">
                      Hello <strong style="color:#374151;">${adminName}</strong>, your workspace is fully activated and ready to receive conversations.
                    </p>
                  </td>
                </tr>

                <!-- Summary Cards -->
                <tr>
                  <td style="padding:24px 36px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="width:33%;padding-right:6px;vertical-align:top;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f9fafb;border-radius:10px;">
                            <tr>
                              <td style="padding:14px 12px;text-align:center;">
                                <p style="margin:0;font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Industry</p>
                                <p style="margin:4px 0 0;font-size:13px;font-weight:600;color:#374151;">${industry}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                        <td style="width:33%;padding:0 3px;vertical-align:top;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f9fafb;border-radius:10px;">
                            <tr>
                              <td style="padding:14px 12px;text-align:center;">
                                <p style="margin:0;font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Priority</p>
                                <p style="margin:4px 0 0;font-size:13px;font-weight:600;color:#374151;">${priority.replace(/_/g, " ")}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                        <td style="width:33%;padding-left:6px;vertical-align:top;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f9fafb;border-radius:10px;">
                            <tr>
                              <td style="padding:14px 12px;text-align:center;">
                                <p style="margin:0;font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">AI Copilot</p>
                                <p style="margin:4px 0 0;font-size:13px;font-weight:600;color:#374151;">Active</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Departments Table -->
                <tr>
                  <td style="padding:0 36px 28px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
                      <tr>
                        <td style="padding:10px 14px;font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;background-color:#f9fafb;border-bottom:1px solid #e5e7eb;">Department</td>
                        <td style="padding:10px 14px;font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;text-align:center;background-color:#f9fafb;border-bottom:1px solid #e5e7eb;">SLA</td>
                      </tr>
                      ${deptRows}
                    </table>
                  </td>
                </tr>

                <!-- CTA -->
                <tr>
                  <td style="padding:0 36px 32px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center">
                          <a href="${dashboardUrl}" target="_blank" style="display:inline-block;background-color:#6366f1;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:10px;mso-padding-alt:12px 32px;">
                            Open Dashboard &rarr;
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
  `);
}

// ─── Waitlist Welcome Email ──────────────────────────────────

function waitlistWelcomeHtml(firstName: string, position: number): string {
  const frontendUrl = process.env.FRONTEND_URL || "https://gotcha.co.il";
  const logoUrl = `${frontendUrl}/logo.png`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're in &mdash; GOTCHA.</title>
  <!--[if mso]>
  <style>table,td{font-family:Arial,sans-serif;}</style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#08080c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#08080c;">
    <tr>
      <td align="center" style="padding:40px 16px 20px;">

        <!-- ━━━ Logo ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td align="center" style="padding-bottom:32px;">
              <img src="${logoUrl}" alt="GOTCHA." width="140" style="display:block;border:0;outline:none;max-width:140px;height:auto;" />
            </td>
          </tr>
        </table>

        <!-- ━━━ Hero Banner ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background:linear-gradient(135deg,#7C3291 0%,#5A72B3 50%,#6DCED9 100%);border-radius:20px 20px 0 0;padding:48px 40px 40px;text-align:center;">
              <!-- Checkmark circle -->
              <div style="margin:0 auto 20px;width:68px;height:68px;border-radius:50%;background-color:rgba(255,255,255,0.18);line-height:68px;text-align:center;">
                <span style="font-size:34px;color:#ffffff;">&#10003;</span>
              </div>
              <h1 style="margin:0 0 8px;font-size:30px;font-weight:800;color:#ffffff;line-height:1.2;letter-spacing:-0.5px;">
                You're in, ${firstName}.
              </h1>
              <p style="margin:0;font-size:16px;color:rgba(255,255,255,0.85);line-height:1.5;font-weight:400;">
                Welcome to the inner circle.
              </p>
            </td>
          </tr>
        </table>

        <!-- ━━━ Position Badge ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;padding:0 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:28px 0;text-align:center;border-bottom:1px solid rgba(255,255,255,0.06);">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;background:linear-gradient(135deg,rgba(124,50,145,0.12) 0%,rgba(109,206,217,0.08) 100%);border:1px solid rgba(124,50,145,0.25);border-radius:14px;">
                      <tr>
                        <td style="padding:16px 32px;text-align:center;">
                          <p style="margin:0 0 2px;font-size:10px;font-weight:700;color:#6DCED9;text-transform:uppercase;letter-spacing:1.5px;">Your position</p>
                          <p style="margin:0;font-size:36px;font-weight:800;color:#ffffff;letter-spacing:-1px;">#${position}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- ━━━ Body Content ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;padding:28px 40px 8px;">
              <p style="margin:0;font-size:15px;color:#a1a1aa;line-height:1.75;">
                You just secured early access to <span style="color:#e4e4e7;font-weight:600;">GOTCHA.</span> &mdash; the unified inbox that brings WhatsApp, Messenger &amp; Instagram into one screen, powered by AI that actually helps your team close faster.
              </p>
            </td>
          </tr>
        </table>

        <!-- ━━━ Timeline Steps ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;padding:28px 40px 32px;">
              <p style="margin:0 0 22px;font-size:11px;font-weight:700;color:#7C3291;text-transform:uppercase;letter-spacing:1.2px;">What happens next</p>

              <!-- Step 1 -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:4px;">
                <tr>
                  <td style="width:40px;vertical-align:top;padding-top:2px;">
                    <div style="width:30px;height:30px;background:linear-gradient(135deg,#7C3291,#5A72B3);border-radius:50%;text-align:center;line-height:30px;color:#fff;font-size:13px;font-weight:800;">1</div>
                  </td>
                  <td style="vertical-align:top;padding-bottom:22px;border-left:2px solid rgba(124,50,145,0.2);padding-left:20px;">
                    <p style="margin:0;font-size:15px;font-weight:700;color:#e4e4e7;">We're preparing your spot</p>
                    <p style="margin:5px 0 0;font-size:13px;color:#71717a;line-height:1.55;">Rolling out in small waves to ensure every team gets a white-glove experience.</p>
                  </td>
                </tr>
              </table>

              <!-- Step 2 -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:4px;">
                <tr>
                  <td style="width:40px;vertical-align:top;padding-top:2px;">
                    <div style="width:30px;height:30px;background:linear-gradient(135deg,#5A72B3,#6DCED9);border-radius:50%;text-align:center;line-height:30px;color:#fff;font-size:13px;font-weight:800;">2</div>
                  </td>
                  <td style="vertical-align:top;padding-bottom:22px;border-left:2px solid rgba(90,114,179,0.2);padding-left:20px;">
                    <p style="margin:0;font-size:15px;font-weight:700;color:#e4e4e7;">Your invite lands in your inbox</p>
                    <p style="margin:5px 0 0;font-size:13px;color:#71717a;line-height:1.55;">Within <strong style="color:#6DCED9;">48 hours</strong> you'll get a personal setup link. No passwords needed.</p>
                  </td>
                </tr>
              </table>

              <!-- Step 3 -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="width:40px;vertical-align:top;padding-top:2px;">
                    <div style="width:30px;height:30px;background:linear-gradient(135deg,#10b981,#6DCED9);border-radius:50%;text-align:center;line-height:30px;color:#fff;font-size:15px;font-weight:800;">&#10003;</div>
                  </td>
                  <td style="vertical-align:top;padding-left:20px;">
                    <p style="margin:0;font-size:15px;font-weight:700;color:#e4e4e7;">Go live in 15 minutes</p>
                    <p style="margin:5px 0 0;font-size:13px;color:#71717a;line-height:1.55;">Connect your channels, upload your knowledge base, and start handling every conversation from one place.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- ━━━ Feature Pills ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;padding:0 40px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.06);border-radius:14px;">
                <tr>
                  <td style="padding:20px 24px 12px;">
                    <p style="margin:0;font-size:10px;font-weight:700;color:#52525b;text-transform:uppercase;letter-spacing:1px;">What you'll unlock</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 24px 20px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="padding:7px 0;">
                          <span style="display:inline-block;font-size:13px;color:#a1a1aa;line-height:1;">
                            <span style="color:#7C3291;margin-right:8px;">&#9670;</span> Unified inbox &mdash; WhatsApp, Messenger, Instagram
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:7px 0;">
                          <span style="display:inline-block;font-size:13px;color:#a1a1aa;line-height:1;">
                            <span style="color:#5A72B3;margin-right:8px;">&#9670;</span> AI co-pilot trained on your knowledge base
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:7px 0;">
                          <span style="display:inline-block;font-size:13px;color:#a1a1aa;line-height:1;">
                            <span style="color:#6DCED9;margin-right:8px;">&#9670;</span> Smart routing &amp; SLA tracking
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:7px 0;">
                          <span style="display:inline-block;font-size:13px;color:#a1a1aa;line-height:1;">
                            <span style="color:#7C3291;margin-right:8px;">&#9670;</span> Visual bot builder &mdash; no code needed
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- ━━━ Closing + Reply CTA ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;border-radius:0 0 20px 20px;padding:0 40px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid rgba(255,255,255,0.06);">
                <tr>
                  <td style="padding:28px 0 0;text-align:center;">
                    <p style="margin:0 0 20px;font-size:14px;color:#71717a;line-height:1.6;">
                      Got questions before your invite arrives?<br>
                      Just hit reply &mdash; a real human reads every message.
                    </p>
                    <p style="margin:0;font-size:14px;color:#52525b;">
                      Talk soon,<br>
                      <strong style="color:#e4e4e7;">The GOTCHA. Team</strong>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- ━━━ Footer ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td align="center" style="padding:28px 16px 12px;">
              <p style="margin:0;color:#3f3f46;font-size:11px;line-height:18px;">
                GOTCHA. &mdash; Smart messaging for modern teams.
              </p>
              <p style="margin:8px 0 0;color:#27272a;font-size:11px;">
                You're receiving this because you signed up at gotcha.co.il
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Send welcome email to new waitlist subscriber.
 */
export async function sendWaitlistWelcomeEmail(email: string, firstName: string, position: number): Promise<void> {
  const subject = `You're in, ${firstName} — welcome to Gotcha. early access`;
  const html = waitlistWelcomeHtml(firstName, position);
  const text = [
    `Hey ${firstName}!`,
    "",
    "Thanks for signing up for early access to Gotcha.",
    "",
    "What happens next:",
    "1. We review your request — we're rolling out in small batches",
    "2. You get your invite — expect an email within 48 hours",
    "3. Go live in 15 minutes — connect channels, upload knowledge base, start chatting",
    "",
    "In the meantime, hit reply if you have any questions — we read every message.",
    "",
    "— The Gotcha. Team",
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

  // Generate magic link token
  const token = await createMagicLink(tenantId, adminUserId);
  const setupUrl = `${frontendUrl}/setup/verify?token=${token}`;

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
