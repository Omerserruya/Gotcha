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

function onboardingEmailHtml(adminName: string, tenantName: string, setupUrl: string): string {
  const frontendUrl = process.env.FRONTEND_URL || "https://gotcha.co.il";
  const logoUrl = `${frontendUrl}/logo.png`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Set up ${tenantName} &mdash; GOTCHA.</title>
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
              <!-- Lightning circle -->
              <div style="margin:0 auto 20px;width:68px;height:68px;border-radius:50%;background-color:rgba(255,255,255,0.18);line-height:68px;text-align:center;">
                <span style="font-size:34px;color:#ffffff;">&#9889;</span>
              </div>
              <h1 style="margin:0 0 8px;font-size:30px;font-weight:800;color:#ffffff;line-height:1.2;letter-spacing:-0.5px;">
                Let's set up ${tenantName}.
              </h1>
              <p style="margin:0;font-size:16px;color:rgba(255,255,255,0.85);line-height:1.5;font-weight:400;">
                Your workspace is ready, ${adminName}.
              </p>
            </td>
          </tr>
        </table>

        <!-- ━━━ CTA Button ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;padding:36px 40px 32px;text-align:center;">
              <a href="${setupUrl}" target="_blank" style="display:inline-block;background-color:#7C3291;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;padding:14px 40px;border-radius:12px;mso-padding-alt:14px 40px;">
                Start Setup Wizard &rarr;
              </a>
            </td>
          </tr>
        </table>

        <!-- ━━━ Timeline Steps ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;padding:0 40px 32px;">
              <p style="margin:0 0 22px;font-size:11px;font-weight:700;color:#7C3291;text-transform:uppercase;letter-spacing:1.2px;">What you'll do</p>

              <!-- Step 1 -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:4px;">
                <tr>
                  <td style="width:40px;vertical-align:top;padding-top:2px;">
                    <div style="width:30px;height:30px;background:linear-gradient(135deg,#7C3291,#5A72B3);border-radius:50%;text-align:center;line-height:30px;color:#fff;font-size:13px;font-weight:800;">1</div>
                  </td>
                  <td style="vertical-align:top;padding-bottom:22px;border-left:2px solid rgba(124,50,145,0.2);padding-left:20px;">
                    <p style="margin:0;font-size:15px;font-weight:700;color:#e4e4e7;">Business Profile</p>
                    <p style="margin:5px 0 0;font-size:13px;color:#71717a;line-height:1.55;">Industry, priorities, and preferences</p>
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
                    <p style="margin:0;font-size:15px;font-weight:700;color:#e4e4e7;">Departments &amp; SLAs</p>
                    <p style="margin:5px 0 0;font-size:13px;color:#71717a;line-height:1.55;">Teams, response targets, and automation rules</p>
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
                    <p style="margin:0;font-size:15px;font-weight:700;color:#e4e4e7;">AI Agents</p>
                    <p style="margin:5px 0 0;font-size:13px;color:#71717a;line-height:1.55;">Auto-configured for each department</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- ━━━ Fallback Link + Expiry ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;padding:0 40px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid rgba(255,255,255,0.06);">
                <tr>
                  <td style="padding:24px 0 0;">
                    <p style="margin:0;font-size:12px;color:#71717a;line-height:1.6;">
                      Button not working? Copy this link:<br>
                      <a href="${setupUrl}" style="color:#6DCED9;word-break:break-all;font-size:12px;">${setupUrl}</a>
                    </p>
                    <p style="margin:10px 0 0;font-size:12px;color:#52525b;">
                      This link expires in <strong style="color:#6DCED9;">48 hours</strong> &bull; No login required
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- ━━━ Closing ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;border-radius:0 0 20px 20px;padding:0 40px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid rgba(255,255,255,0.06);">
                <tr>
                  <td style="padding:28px 0 0;text-align:center;">
                    <p style="margin:0 0 20px;font-size:14px;color:#71717a;line-height:1.6;">
                      Need help? Just hit reply &mdash; a real human reads every message.
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
                You're receiving this because your workspace was created on gotcha.co.il
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

function activationEmailHtml(
  adminName: string,
  tenantName: string,
  industry: string,
  priority: string,
  departments: { name: string; sla: string }[],
  dashboardUrl: string,
): string {
  const frontendUrl = process.env.FRONTEND_URL || "https://gotcha.co.il";
  const logoUrl = `${frontendUrl}/logo.png`;

  const deptRows = departments
    .map(
      (d) => `
                      <tr>
                        <td style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);font-size:14px;color:#e4e4e7;">${d.name}</td>
                        <td style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);text-align:center;font-size:14px;color:#a1a1aa;">${d.sla}</td>
                      </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${tenantName} is live &mdash; GOTCHA.</title>
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
                ${tenantName} is live.
              </h1>
              <p style="margin:0;font-size:16px;color:rgba(255,255,255,0.85);line-height:1.5;font-weight:400;">
                Everything's set up and ready to go, ${adminName}.
              </p>
            </td>
          </tr>
        </table>

        <!-- ━━━ Summary Cards ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;padding:32px 40px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="width:33%;padding-right:6px;vertical-align:top;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.06);border-radius:14px;">
                      <tr>
                        <td style="padding:16px 12px;text-align:center;">
                          <p style="margin:0;font-size:10px;font-weight:700;color:#7C3291;text-transform:uppercase;letter-spacing:0.5px;">Industry</p>
                          <p style="margin:6px 0 0;font-size:13px;font-weight:600;color:#e4e4e7;">${industry}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td style="width:33%;padding:0 3px;vertical-align:top;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.06);border-radius:14px;">
                      <tr>
                        <td style="padding:16px 12px;text-align:center;">
                          <p style="margin:0;font-size:10px;font-weight:700;color:#5A72B3;text-transform:uppercase;letter-spacing:0.5px;">Priority</p>
                          <p style="margin:6px 0 0;font-size:13px;font-weight:600;color:#e4e4e7;">${priority.replace(/_/g, " ")}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td style="width:33%;padding-left:6px;vertical-align:top;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.06);border-radius:14px;">
                      <tr>
                        <td style="padding:16px 12px;text-align:center;">
                          <p style="margin:0;font-size:10px;font-weight:700;color:#6DCED9;text-transform:uppercase;letter-spacing:0.5px;">AI Copilot</p>
                          <p style="margin:6px 0 0;font-size:13px;font-weight:600;color:#e4e4e7;">Active</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- ━━━ Departments Table ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;padding:0 40px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.06);border-radius:14px;overflow:hidden;">
                <tr>
                  <td style="padding:12px 16px;font-size:11px;font-weight:700;color:#52525b;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid rgba(255,255,255,0.06);">Department</td>
                  <td style="padding:12px 16px;font-size:11px;font-weight:700;color:#52525b;text-transform:uppercase;letter-spacing:0.5px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.06);">SLA</td>
                </tr>
                ${deptRows}
              </table>
            </td>
          </tr>
        </table>

        <!-- ━━━ CTA Button ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;padding:0 40px 32px;text-align:center;">
              <a href="${dashboardUrl}" target="_blank" style="display:inline-block;background-color:#7C3291;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;padding:14px 40px;border-radius:12px;mso-padding-alt:14px 40px;">
                Open Dashboard &rarr;
              </a>
            </td>
          </tr>
        </table>

        <!-- ━━━ Closing ━━━ -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;border-radius:0 0 20px 20px;padding:0 40px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid rgba(255,255,255,0.06);">
                <tr>
                  <td style="padding:28px 0 0;text-align:center;">
                    <p style="margin:0 0 20px;font-size:14px;color:#71717a;line-height:1.6;">
                      Your AI agents are standing by &mdash; ready to handle every conversation.
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
                You're receiving this because your workspace was activated on gotcha.co.il
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
 * Send password reset email with magic link.
 */
export async function sendPasswordResetEmail(
  tenantId: string,
  email: string,
  userName: string,
  tenantName: string,
  token: string,
): Promise<void> {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  const resetUrl = `${frontendUrl}/login?resetToken=${token}`;
  const logoUrl = `${frontendUrl}/logo.png`;

  const subject = `Reset your password — ${tenantName}`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Password &mdash; GOTCHA.</title>
</head>
<body style="margin:0;padding:0;background-color:#08080c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#08080c;">
    <tr>
      <td align="center" style="padding:40px 16px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td align="center" style="padding-bottom:32px;">
              <img src="${logoUrl}" alt="GOTCHA." width="140" style="display:block;border:0;outline:none;max-width:140px;height:auto;" />
            </td>
          </tr>
        </table>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background:linear-gradient(135deg,#7C3291 0%,#5A72B3 50%,#6DCED9 100%);border-radius:20px 20px 0 0;padding:48px 40px 40px;text-align:center;">
              <div style="margin:0 auto 20px;width:68px;height:68px;border-radius:50%;background-color:rgba(255,255,255,0.18);line-height:68px;text-align:center;">
                <span style="font-size:34px;color:#ffffff;">&#128274;</span>
              </div>
              <h1 style="margin:0 0 8px;font-size:30px;font-weight:800;color:#ffffff;line-height:1.2;letter-spacing:-0.5px;">
                Reset your password
              </h1>
              <p style="margin:0;font-size:16px;color:rgba(255,255,255,0.85);line-height:1.5;font-weight:400;">
                Hi ${userName}, we received a password reset request.
              </p>
            </td>
          </tr>
        </table>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;padding:36px 40px 32px;text-align:center;">
              <p style="margin:0 0 24px;font-size:15px;color:#a1a1aa;line-height:1.6;">
                Click the button below to set a new password for your <strong style="color:#e4e4e7;">${tenantName}</strong> account.
              </p>
              <a href="${resetUrl}" target="_blank" style="display:inline-block;background-color:#7C3291;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;padding:14px 40px;border-radius:12px;">
                Reset Password &rarr;
              </a>
            </td>
          </tr>
        </table>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;padding:0 40px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid rgba(255,255,255,0.06);">
                <tr>
                  <td style="padding:24px 0 0;">
                    <p style="margin:0;font-size:12px;color:#71717a;line-height:1.6;">
                      Button not working? Copy this link:<br>
                      <a href="${resetUrl}" style="color:#6DCED9;word-break:break-all;font-size:12px;">${resetUrl}</a>
                    </p>
                    <p style="margin:10px 0 0;font-size:12px;color:#52525b;">
                      This link expires in <strong style="color:#6DCED9;">1 hour</strong>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td style="background-color:#0f0f16;border-radius:0 0 20px 20px;padding:0 40px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid rgba(255,255,255,0.06);">
                <tr>
                  <td style="padding:28px 0 0;text-align:center;">
                    <p style="margin:0 0 12px;font-size:13px;color:#71717a;line-height:1.6;">
                      If you didn't request this, you can safely ignore this email.
                    </p>
                    <p style="margin:0;font-size:14px;color:#52525b;">
                      <strong style="color:#e4e4e7;">The GOTCHA. Team</strong>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td align="center" style="padding:28px 16px 12px;">
              <p style="margin:0;color:#3f3f46;font-size:11px;line-height:18px;">GOTCHA. &mdash; Smart messaging for modern teams.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `Hi ${userName},`,
    "",
    "We received a request to reset your password.",
    "",
    "Click the link below to set a new password:",
    resetUrl,
    "",
    "This link expires in 1 hour.",
    "",
    "If you didn't request this, you can safely ignore this email.",
    "",
    "— The GOTCHA. Team",
  ].join("\n");

  const payload: NotificationPayload = {
    tenantId,
    channel: "email",
    type: "password_reset",
    recipient: email,
    subject,
    body: text,
    metadata: { resetUrl },
  };

  try {
    await sendHtmlEmail(email, subject, html, text);
    await logNotification(payload, "sent");
  } catch (err: any) {
    console.error("Failed to send password reset email:", err);
    await logNotification(payload, "failed", err.message);
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
