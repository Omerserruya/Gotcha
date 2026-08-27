/**
 * ONE visual system for every email the product sends.
 *
 * It lives in `shared` and not in a service because the receipt now comes from
 * us rather than from the payment provider: billing, auth and notifications all
 * render mail, and three services drifting into three looks is how a product
 * stops feeling like one product.
 *
 * The design: a near-black canvas, a single warm off-white card, one very large
 * tight headline, and colour used only where it has a job. Everything is tables
 * and inline styles, because that is what mail clients actually render.
 *
 * Two rules the layout depends on:
 *
 *   1. Row builders return a full-width `<tr>…</tr>` and are dropped into
 *      `bodyHtml`. They MUST use CARD_PAD so their left edge lines up with the
 *      headline above them.
 *   2. Nothing here throws. An email that cannot render is an email that does
 *      not send, and some of these carry a receipt.
 */
import { resolveAppPublicUrl } from "../app-origins";

/** The palette. Named by role, not by colour, so a retheme stays a one-file edit. */
const EC = {
  canvas: "#0A0A0B",
  card: "#F7F7F4",
  cardBorder: "#202024",
  panel: "#FFFFFF",
  panelBorder: "#E3E3DF",
  chip: "#E8E8E4",
  ink: "#0A0A0B",
  strong: "#111113",
  body: "#55555B",
  muted: "#8A8A90",
  faint: "#9A9A9F",
  onDark: "#FFFFFF",
  onDarkMuted: "#77777C",
  onDarkFaint: "#6C6C72",
  onDarkLink: "#A6A6AB",
  divider: "#E3E3DF",
} as const;

/** Exposed so a one-off block in a template can match the system instead of inventing a colour. */
export const EMAIL_COLORS = EC;

export const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

/** Horizontal padding of the card. Row builders must match it. */
const CARD_PAD = "42px";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/**
 * The brand mark, as an image with a live text fallback.
 *
 * `resolveAppPublicUrl` throws when the origin is unset or not https in
 * production. That is correct for a redirect and wrong for an email, so a
 * failure here degrades to the wordmark instead of taking the send with it.
 */
function brandMark(): string {
  let src: string | null = null;
  try {
    src = `${resolveAppPublicUrl()}/full_icon_white.png`;
  } catch {
    src = null;
  }
  const wordmark = `<span style="font-family:${EMAIL_FONT};font-size:20px;line-height:24px;font-weight:800;letter-spacing:-0.8px;color:${EC.onDark};">GOTCHA</span>`;
  if (!src) return wordmark;
  // The alt text IS the fallback: with images blocked, the wordmark still reads.
  return `<img src="${src}" width="118" alt="GOTCHA" style="display:block;width:118px;max-width:118px;height:auto;border:0;outline:none;text-decoration:none;">`;
}

export interface BrandEmailArgs {
  title: string;               // <title>
  preheader?: string;          // hidden inbox preview line
  eyebrow?: string;            // small uppercase label above the headline
  icon?: string;               // emoji / HTML entity, rendered inside the eyebrow chip
  headline: string;            // escape dynamic parts at the call site
  subhead?: string;
  bodyHtml?: string;           // inner card rows (use the email* builders)
  cta?: { label: string; url: string };
  fallbackUrl?: string;        // "button not working?" link
  expiryNote?: string;
  closingHtml?: string;        // replaces the default sign-off when set
  belowCardHtml?: string;      // extra block between the card and the footer
  footerNote?: string;         // the "why you got this" line
  locale?: string;             // "he" → RTL
}

/** Canonical positioning, mirroring landing.hero in the frontend i18n. */
function tagline(he: boolean): string {
  return he ? "בונים את עתיד התקשורת עם הלקוחות" : "Building the future of customer communication";
}

export function renderBrandEmail(a: BrandEmailArgs): string {
  const he = a.locale === "he";
  const dir = he ? "rtl" : "ltr";
  const align = he ? "right" : "left";
  const opposite = he ? "left" : "right";
  const arrow = he ? "&larr;" : "&rarr;";

  const closing = a.closingHtml ?? `
    <p style="margin:0 0 12px;font-family:${EMAIL_FONT};font-size:13px;line-height:21px;color:${EC.muted};">${
      he
        ? "צריכים עזרה? פשוט השיבו למייל הזה, בן אדם אמיתי קורא כל הודעה."
        : "Need help? Just reply to this email. A real person reads every message."
    }</p>
    <p style="margin:0;font-family:${EMAIL_FONT};font-size:13px;line-height:21px;color:${EC.muted};">${he ? "נתראה בקרוב," : "Talk soon,"}<br><strong style="color:${EC.strong};">${he ? "צוות GOTCHA" : "The GOTCHA Team"}</strong></p>`;

  return `<!DOCTYPE html>
<html lang="${he ? "he" : "en"}" dir="${dir}" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${a.title}</title>
  <!--[if mso]><style>table,td{font-family:Arial,sans-serif;}</style><![endif]-->
  <style>
    @media only screen and (max-width:640px) {
      .container { width:100% !important; }
      .pad { padding-left:22px !important; padding-right:22px !important; }
      .hero-title { font-size:32px !important; line-height:36px !important; letter-spacing:-1.2px !important; }
      .meta-col { display:block !important; width:100% !important; padding-bottom:14px !important; }
    }
  </style>
</head>
<body dir="${dir}" style="margin:0;padding:0;background:${EC.canvas};-webkit-font-smoothing:antialiased;">
  ${a.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${a.preheader}</div>` : ""}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${EC.canvas};">
    <tr>
      <td align="center" style="padding:36px 16px 48px;">
        <table role="presentation" class="container" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:600px;">

          <!-- Brand -->
          <tr>
            <td style="padding:0 6px 22px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" dir="${dir}">
                <tr>
                  <td align="${align}">
                    <a href="${safeHref(appUrl())}" style="text-decoration:none;">${brandMark()}</a>
                  </td>
                  <td align="${opposite}" style="font-family:${EMAIL_FONT};font-size:11px;line-height:14px;font-weight:700;letter-spacing:1.3px;color:${EC.onDarkMuted};">
                    ${escapeHtml(tagline(he)).toUpperCase()}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:${EC.card};border-radius:24px;border:1px solid ${EC.cardBorder};">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" dir="${dir}">

                ${a.eyebrow ? `<tr>
                  <td class="pad" align="${align}" style="padding:34px ${CARD_PAD} 0;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}">
                      <tr>
                        <td style="background:${EC.chip};border-radius:999px;padding:7px 12px;">
                          <span style="font-family:${EMAIL_FONT};font-size:11px;line-height:14px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:${EC.ink};">${a.icon ? `${a.icon} ` : ""}${a.eyebrow}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>` : ""}

                <tr>
                  <td class="pad" style="padding:${a.eyebrow ? "22px" : "38px"} ${CARD_PAD} 0;text-align:${align};">
                    <h1 class="hero-title" style="margin:0;font-family:${EMAIL_FONT};font-size:42px;line-height:46px;letter-spacing:-2px;font-weight:800;color:${EC.ink};">${a.headline}</h1>
                  </td>
                </tr>

                ${a.subhead ? `<tr>
                  <td class="pad" style="padding:18px ${CARD_PAD} 0;text-align:${align};">
                    <p style="margin:0;font-family:${EMAIL_FONT};font-size:16px;line-height:25px;color:${EC.body};">${a.subhead}</p>
                  </td>
                </tr>` : ""}

                ${a.bodyHtml || ""}

                ${a.cta ? `<tr>
                  <td class="pad" style="padding:28px ${CARD_PAD} 0;text-align:${align};">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}">
                      <tr>
                        <td bgcolor="${EC.ink}" style="border-radius:12px;">
                          <a href="${a.cta.url}" target="_blank" style="display:inline-block;padding:15px 24px;font-family:${EMAIL_FONT};font-size:14px;line-height:18px;font-weight:800;color:${EC.onDark};text-decoration:none;mso-padding-alt:15px 24px;">${a.cta.label} ${arrow}</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>` : ""}

                ${a.fallbackUrl ? `<tr>
                  <td class="pad" style="padding:26px ${CARD_PAD} 0;text-align:${align};">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid ${EC.divider};">
                      <tr>
                        <td style="padding:18px 0 0;">
                          <p style="margin:0;font-family:${EMAIL_FONT};font-size:12px;line-height:19px;color:${EC.muted};">${he ? "הכפתור לא עובד? העתיקו את הקישור:" : "Button not working? Copy this link:"}<br>
                            <a href="${a.fallbackUrl}" style="color:${EC.strong};word-break:break-all;font-size:12px;">${a.fallbackUrl}</a></p>
                          ${a.expiryNote ? `<p style="margin:8px 0 0;font-family:${EMAIL_FONT};font-size:12px;line-height:19px;color:${EC.faint};">${a.expiryNote}</p>` : ""}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>` : ""}

                <tr>
                  <td class="pad" style="padding:28px ${CARD_PAD} 36px;text-align:${align};">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid ${EC.divider};">
                      <tr><td style="padding:22px 0 0;">${closing}</td></tr>
                    </table>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          ${a.belowCardHtml || ""}

          <!-- Footer -->
          <tr>
            <td style="padding:22px 8px 0;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" dir="${dir}">
                <tr>
                  <td valign="top" align="${align}" style="font-family:${EMAIL_FONT};font-size:11px;line-height:18px;color:${EC.onDarkFaint};">
                    GOTCHA<br>${escapeHtml(tagline(he))}
                    ${a.footerNote ? `<br><span style="color:${EC.onDarkMuted};">${a.footerNote}</span>` : ""}
                    <br><span style="color:${EC.onDarkFaint};">${legalConsentHtml(he)}</span>
                  </td>
                  <td valign="top" align="${opposite}" style="font-family:${EMAIL_FONT};font-size:11px;line-height:18px;color:${EC.onDarkFaint};">
                    <a href="${safeHref(appUrl())}" style="color:${EC.onDarkLink};text-decoration:none;">gotcha.co.il</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function appUrl(): string {
  try {
    return resolveAppPublicUrl();
  } catch {
    return "https://gotcha.co.il";
  }
}

/**
 * Where the public Terms and Privacy Policy live.
 *
 * `/legal/:slug` is served by the same app on every host and is not gated
 * behind the marketing check, so the app origin every other email link is
 * built from is the right base here too.
 */
export function legalUrls(): { terms: string; privacy: string } {
  const base = appUrl();
  return {
    terms: `${base}/legal/terms-of-service`,
    privacy: `${base}/legal/privacy-policy`,
  };
}

/**
 * The standing consent line at the bottom of every email we send.
 *
 * Setting a workspace up and connecting accounts is the moment the agreement is
 * actually entered into, so the email that accompanies it is where the terms
 * have to be reachable. It is deliberately quiet: this is a disclosure, not a
 * message, and it should never compete with the thing the email is about.
 */
export function legalConsentHtml(he = false): string {
  const { terms, privacy } = legalUrls();
  const link = (href: string, label: string) =>
    `<a href="${safeHref(href)}" style="color:${EC.onDarkLink};text-decoration:underline;">${label}</a>`;
  return he
    ? `ההקמה והחיבור של חשבונות מהווים הסכמה ל${link(terms, "תנאי השימוש")} ול${link(privacy, "מדיניות הפרטיות")} שלנו.`
    : `Setting up your workspace and connecting accounts means you accept our ${link(terms, "Terms of Service")} and ${link(privacy, "Privacy Policy")}.`;
}

/** The same line for the text/plain part, where a link has to be spelled out. */
export function legalConsentText(he = false): string {
  const { terms, privacy } = legalUrls();
  return he
    ? `ההקמה והחיבור של חשבונות מהווים הסכמה לתנאי השימוש (${terms}) ולמדיניות הפרטיות (${privacy}) שלנו.`
    : `Setting up your workspace and connecting accounts means you accept our Terms of Service (${terms}) and Privacy Policy (${privacy}).`;
}

/**
 * Append the consent line to a plain-text body once.
 *
 * Idempotent, because several senders build their text body by composing
 * smaller pieces and one of them may already have added it.
 */
export function withLegalConsentText(text: string, he = false): string {
  const line = legalConsentText(he);
  if (text.includes(legalUrls().terms)) return text;
  return `${text.replace(/\s+$/, "")}\n\n---\n${line}`;
}

function safeHref(url: string): string {
  return escapeHtml(url);
}

// ── Row builders. Each returns a full-width card row (<tr>…</tr>). ───────────

export function emailParagraph(html: string, locale?: string): string {
  const align = locale === "he" ? "right" : "left";
  return `<tr><td class="pad" style="padding:22px ${CARD_PAD} 0;text-align:${align};"><p style="margin:0;font-family:${EMAIL_FONT};font-size:15px;line-height:24px;color:${EC.body};">${html}</p></td></tr>`;
}

/**
 * The two-up fact panel: the receipt's amount and document number, the
 * invitation's workspace and address. Reads as a record rather than as prose,
 * which is what someone filing an email actually wants.
 */
export function emailMetaPanel(items: Array<{ label: string; value: string }>, locale?: string): string {
  const align = locale === "he" ? "right" : "left";
  if (items.length === 0) return "";
  const width = Math.floor(100 / Math.min(items.length, 2));
  const cells = items.map(
    (it) => `<td class="meta-col" width="${width}%" valign="top" align="${align}" style="padding-bottom:2px;">
        <div style="font-family:${EMAIL_FONT};font-size:10px;line-height:14px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${EC.faint};">${it.label}</div>
        <div style="margin-top:5px;font-family:${EMAIL_FONT};font-size:15px;line-height:21px;font-weight:700;color:${EC.strong};">${it.value}</div>
      </td>`,
  );
  // Two per row: three across is unreadable on a phone, and the mobile rule
  // stacks them anyway. A trailing odd cell gets an empty partner so the last
  // row keeps the same column widths as the ones above it.
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    const pair = cells.slice(i, i + 2);
    if (pair.length === 1 && cells.length > 1) pair.push(`<td class="meta-col" width="${width}%">&nbsp;</td>`);
    rows.push(`<tr>${pair.join("")}</tr>`);
  }
  return `<tr>
    <td class="pad" style="padding:26px ${CARD_PAD} 0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${EC.panel};border:1px solid ${EC.panelBorder};border-radius:16px;">
        <tr>
          <td style="padding:18px 20px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows.join("")}</table>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

/** A single emphasised figure: the amount charged, the credits granted. */
export function emailAmount(label: string, value: string, sub?: string, locale?: string): string {
  const align = locale === "he" ? "right" : "left";
  return `<tr>
    <td class="pad" style="padding:26px ${CARD_PAD} 0;text-align:${align};">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${EC.panel};border:1px solid ${EC.panelBorder};border-radius:16px;">
        <tr>
          <td align="${align}" style="padding:22px 20px;">
            <div style="font-family:${EMAIL_FONT};font-size:10px;line-height:14px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${EC.faint};">${label}</div>
            <div style="margin-top:6px;font-family:${EMAIL_FONT};font-size:34px;line-height:38px;font-weight:800;letter-spacing:-1.2px;color:${EC.ink};">${value}</div>
            ${sub ? `<div style="margin-top:6px;font-family:${EMAIL_FONT};font-size:12px;line-height:18px;color:${EC.muted};">${sub}</div>` : ""}
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

export function emailSteps(caption: string, steps: Array<{ marker: string; title: string; desc: string }>, locale?: string): string {
  const align = locale === "he" ? "right" : "left";
  const rows = steps
    .map(
      (s, i) => `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" dir="${locale === "he" ? "rtl" : "ltr"}" style="margin-bottom:${i === steps.length - 1 ? "0" : "16px"};">
        <tr>
          <td width="38" valign="top" style="width:38px;">
            <div style="width:28px;height:28px;background:${EC.ink};border-radius:50%;text-align:center;line-height:28px;color:${EC.onDark};font-family:${EMAIL_FONT};font-size:12px;font-weight:800;">${s.marker}</div>
          </td>
          <td valign="top" align="${align}" style="padding:0 10px;">
            <div style="font-family:${EMAIL_FONT};font-size:14px;line-height:20px;font-weight:700;color:${EC.strong};">${s.title}</div>
            <div style="margin-top:3px;font-family:${EMAIL_FONT};font-size:13px;line-height:20px;color:${EC.body};">${s.desc}</div>
          </td>
        </tr>
      </table>`,
    )
    .join("");
  return `<tr>
    <td class="pad" style="padding:26px ${CARD_PAD} 0;text-align:${align};">
      <div style="font-family:${EMAIL_FONT};font-size:10px;line-height:14px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${EC.faint};margin-bottom:14px;">${caption}</div>
      ${rows}
    </td>
  </tr>`;
}

export function emailKeyValueTable(headers: [string, string], rows: Array<[string, string]>, locale?: string): string {
  const align = locale === "he" ? "right" : "left";
  const opposite = locale === "he" ? "left" : "right";
  const body = rows
    .map(
      ([k, v]) => `<tr>
        <td align="${align}" style="padding:11px 0;border-top:1px solid ${EC.panelBorder};font-family:${EMAIL_FONT};font-size:14px;line-height:20px;color:${EC.body};">${k}</td>
        <td align="${opposite}" style="padding:11px 0;border-top:1px solid ${EC.panelBorder};font-family:${EMAIL_FONT};font-size:14px;line-height:20px;font-weight:700;color:${EC.strong};">${v}</td>
      </tr>`,
    )
    .join("");
  return `<tr>
    <td class="pad" style="padding:26px ${CARD_PAD} 0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" dir="${locale === "he" ? "rtl" : "ltr"}">
        <tr>
          <td align="${align}" style="padding-bottom:4px;font-family:${EMAIL_FONT};font-size:10px;line-height:14px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${EC.faint};">${headers[0]}</td>
          <td align="${opposite}" style="padding-bottom:4px;font-family:${EMAIL_FONT};font-size:10px;line-height:14px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${EC.faint};">${headers[1]}</td>
        </tr>
        ${body}
      </table>
    </td>
  </tr>`;
}

export function emailBadge(caption: string, value: string, locale?: string): string {
  const align = locale === "he" ? "right" : "left";
  return `<tr>
    <td class="pad" style="padding:26px ${CARD_PAD} 0;text-align:${align};">
      <div style="font-family:${EMAIL_FONT};font-size:10px;line-height:14px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${EC.faint};margin-bottom:8px;">${caption}</div>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}">
        <tr>
          <td style="background:${EC.chip};border-radius:999px;padding:8px 14px;font-family:${EMAIL_FONT};font-size:14px;line-height:18px;font-weight:800;color:${EC.ink};">${value}</td>
        </tr>
      </table>
    </td>
  </tr>`;
}

export function emailPills(caption: string, items: string[], locale?: string): string {
  const align = locale === "he" ? "right" : "left";
  const pills = items
    .map(
      (i) => `<td style="padding:0 6px 6px 0;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
        <td style="background:${EC.chip};border-radius:999px;padding:6px 12px;font-family:${EMAIL_FONT};font-size:12px;line-height:16px;font-weight:700;color:${EC.ink};">${i}</td>
      </tr></table></td>`,
    )
    .join("");
  return `<tr>
    <td class="pad" style="padding:26px ${CARD_PAD} 0;text-align:${align};">
      <div style="font-family:${EMAIL_FONT};font-size:10px;line-height:14px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${EC.faint};margin-bottom:10px;">${caption}</div>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}"><tr>${pills}</tr></table>
    </td>
  </tr>`;
}

export function emailStatCards(cards: Array<{ label: string; value: string }>, locale?: string): string {
  return emailMetaPanel(cards.map((c) => ({ label: c.label, value: c.value })), locale);
}

/** A quiet note under the card, for the legal or "why you got this" line. */
export function emailBelowCardNote(html: string, locale?: string): string {
  const align = locale === "he" ? "right" : "left";
  return `<tr><td style="padding:18px 8px 0;text-align:${align};">
    <p style="margin:0;font-family:${EMAIL_FONT};font-size:11px;line-height:18px;color:${EC.onDarkFaint};">${html}</p>
  </td></tr>`;
}
