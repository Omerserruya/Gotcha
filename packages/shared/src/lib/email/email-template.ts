/**
 * A channel's own HTML email template (2026-10-22).
 *
 * A workspace can wrap every email it sends from one email channel account
 * (Gmail, Outlook, SMTP) in its own HTML: its logo, its colours, its footer.
 * The template is stored per channel account as a durable tenant setting and
 * applied once, where email leaves (channels/email-template-apply.ts).
 *
 * This module is pure: sanitizing on save, the save-time checks, and filling
 * the placeholders. Nothing here reads the database or sends anything.
 *
 * ★ The sanitizer is a TOKENIZER, not a set of search-and-replace patterns.
 *   It walks the markup tag by tag, so `<scr<script>ipt>` or an attribute that
 *   merely mentions "onclick" in its value cannot slip past or be mangled.
 *   There is no HTML sanitizer among the repo's dependencies, and adding one
 *   is not allowed, hence the hand-written walker.
 *
 * ★ The template is the customer-facing shell of a real email, so it is
 *   rendered by mail clients, which do not run scripts anyway. The sanitizer
 *   exists for the places that are NOT a mail client: the app's own preview,
 *   a forwarded copy opened in a browser, and plain hygiene. It strips what
 *   can run or submit, and keeps everything that is layout (tables, inline
 *   styles, <style> blocks, Outlook conditional comments).
 */

import { escapeHtml } from "./brand-email";

export const EMAIL_TEMPLATE_MAX_BYTES = 100 * 1024;

/** The durable setting key for one channel account's template. */
export function emailTemplateKey(channelAccountId: string): string {
  return `emailTemplate:${channelAccountId}`;
}

/** What is stored under emailTemplateKey(). `html` is always the sanitized form. */
export interface StoredEmailTemplate {
  html: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

/** Parse a stored setting; anything unreadable is "no template", never a throw. */
export function parseStoredEmailTemplate(raw: string | null): StoredEmailTemplate | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || typeof v.html !== "string") return null;
    return {
      html: v.html,
      enabled: v.enabled === true,
      updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : new Date(0).toISOString(),
      updatedBy: typeof v.updatedBy === "string" ? v.updatedBy : null,
    };
  } catch {
    return null;
  }
}

/** The names reported back to the editor, in this order when present. */
export const REMOVED_KINDS = ["script", "iframe", "object", "embed", "form", "on*", "javascript:"] as const;
export type RemovedKind = (typeof REMOVED_KINDS)[number];

/** Elements dropped WITH their content. */
const DROP_WITH_CONTENT = new Set(["script", "iframe", "object", "embed"]);
/** Of those, the ones that never have content or a close tag. */
const VOID_DROPS = new Set(["embed"]);
/**
 * Form controls: the tags go, what they wrap stays (a form's text is usually
 * the email's own copy). All reported as "form".
 */
const FORM_TAGS = new Set(["form", "input", "button", "select", "option", "textarea"]);
/** Attributes whose value is a URL a click or a load can follow. */
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "background", "poster", "xlink:href", "data", "lowsrc", "dynsrc", "srcset"]);

const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
const ATTR_RE = /([^\s"'>\/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/** Decode the entities an attacker would use to hide `javascript:` in a URL. */
function decodeForUrlCheck(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;|&newline;/gi, "")
    // Browsers ignore whitespace and control characters inside a scheme.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x20\x7f]+/g, "")
    .toLowerCase();
}

function isScriptUrl(value: string): boolean {
  const v = decodeForUrlCheck(value);
  return v.startsWith("javascript:") || v.startsWith("vbscript:") || v.startsWith("data:text/html");
}

/** `style="background:url(javascript:...)"` and IE's expression(). */
function isScriptStyle(value: string): boolean {
  const v = decodeForUrlCheck(value);
  return v.includes("javascript:") || v.includes("vbscript:") || v.includes("expression(");
}

function cleanAttributes(raw: string, removed: Set<RemovedKind>): string {
  let out = "";
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw))) {
    const name = m[1]!;
    const lname = name.toLowerCase();
    const quoted = m[2];
    const value = quoted === undefined ? "" : quoted.replace(/^["']|["']$/g, "");
    if (lname.startsWith("on")) {
      removed.add("on*");
      continue;
    }
    if (URL_ATTRS.has(lname) && quoted !== undefined && isScriptUrl(value)) {
      removed.add("javascript:");
      continue;
    }
    if (lname === "style" && quoted !== undefined && isScriptStyle(value)) {
      removed.add("javascript:");
      continue;
    }
    out += quoted === undefined ? ` ${name}` : ` ${name}=${quoted}`;
  }
  return out;
}

/**
 * Strip what can run or submit; keep everything that is layout.
 * Returns the cleaned html and what was removed, in REMOVED_KINDS order.
 */
export function sanitizeEmailTemplate(html: string): { html: string; removed: RemovedKind[] } {
  const removed = new Set<RemovedKind>();
  const out = sanitizeInto(html, removed);
  return { html: out, removed: REMOVED_KINDS.filter((k) => removed.has(k)) };
}

function sanitizeInto(html: string, removed: Set<RemovedKind>): string {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    const rest = html.slice(lt);

    // Comments, including Outlook's conditional ones (<!--[if mso]> ... <![endif]-->):
    // kept, with their inside sanitized the same way.
    if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->", 4);
      const inner = end < 0 ? rest.slice(4) : rest.slice(4, end);
      out += `<!--${sanitizeInto(inner, removed)}-->`;
      i = end < 0 ? html.length : lt + end + 3;
      continue;
    }
    // <!DOCTYPE ...>, other declarations, and the <![endif]> / <![if ...]>
    // markers inside Outlook conditional comments pass through.
    if (/^<!(?:[a-zA-Z]|\[)/.test(rest)) {
      const end = rest.indexOf(">");
      out += end < 0 ? rest : rest.slice(0, end + 1);
      i = end < 0 ? html.length : lt + end + 1;
      continue;
    }

    const m = TAG_RE.exec(rest);
    if (!m) {
      // A bare "<" that is not a tag (e.g. "a < b"): escape it so it can never
      // combine with what follows into one.
      out += "&lt;";
      i = lt + 1;
      continue;
    }
    const [whole, closing, rawName, attrs, selfClose] = m;
    const name = rawName!.toLowerCase();
    i = lt + whole.length;

    if (DROP_WITH_CONTENT.has(name)) {
      removed.add(name as RemovedKind);
      // <embed> is a void element: it has no content and no close tag.
      if (!closing && !selfClose && !VOID_DROPS.has(name)) {
        // Skip to the matching close tag; without one, the rest is dropped too
        // (an unclosed <script> swallows the document in a browser as well).
        const close = new RegExp(`</${name}\\s*>`, "i").exec(html.slice(i));
        i = close ? i + close.index + close[0].length : html.length;
      }
      continue;
    }
    if (FORM_TAGS.has(name)) {
      removed.add("form");
      continue;
    }
    if (closing) {
      out += `</${rawName}>`;
      continue;
    }
    out += `<${rawName}${cleanAttributes(attrs ?? "", removed)}${selfClose ? " /" : ""}>`;
  }
  return out;
}

const CONTENT_RE = /\{\{\s*content\s*\}\}/;

export type EmailTemplateError =
  | { code: "EMAIL_TEMPLATE_TOO_LARGE"; max: number }
  | { code: "EMAIL_TEMPLATE_CONTENT_PLACEHOLDER_MISSING" };

/**
 * The save-time contract: size measured in UTF-8 bytes on what was sent, then
 * sanitized, then {{content}} required in what will actually be stored.
 */
export function prepareEmailTemplate(
  html: string,
): { ok: true; html: string; removed: RemovedKind[] } | { ok: false; error: EmailTemplateError } {
  if (Buffer.byteLength(html, "utf8") > EMAIL_TEMPLATE_MAX_BYTES) {
    return { ok: false, error: { code: "EMAIL_TEMPLATE_TOO_LARGE", max: EMAIL_TEMPLATE_MAX_BYTES } };
  }
  const clean = sanitizeEmailTemplate(html);
  if (!CONTENT_RE.test(clean.html)) {
    return { ok: false, error: { code: "EMAIL_TEMPLATE_CONTENT_PLACEHOLDER_MISSING" } };
  }
  return { ok: true, html: clean.html, removed: clean.removed };
}

/** A plain-text message body as HTML: escaped, line breaks kept. */
export function textToEmailHtml(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, "<br>\n");
}

export interface EmailTemplateValues {
  /** Already-safe HTML (see textToEmailHtml). Inserted as is. */
  contentHtml: string;
  agentName?: string | null;
  businessName?: string | null;
  customerName?: string | null;
}

/**
 * Fill the placeholders. Every value is HTML-escaped except {{content}}, which
 * is already HTML. An unknown {{x}} is left exactly as typed.
 */
export function renderEmailTemplate(template: string, values: EmailTemplateValues): string {
  const text: Record<string, string> = {
    agent_name: values.agentName ?? "",
    business_name: values.businessName ?? "",
    customer_name: values.customerName ?? "",
  };
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, name: string) => {
    if (name === "content") return values.contentHtml;
    return name in text ? escapeHtml(text[name]!) : whole;
  });
}
