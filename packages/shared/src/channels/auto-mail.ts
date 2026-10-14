/**
 * Mail no person wrote (2026-10-14): bounces, delivery reports, out-of-office
 * and bulk mail. Ingesting it opened a conversation with mailer-daemon, and
 * the AI could answer it. Every email ingest path asks this first and drops
 * the message (logged with the reason) when it says why.
 *
 * Standards it follows: RFC 3834 (Auto-Submitted, anything but "no"), RFC 3464
 * (delivery status notifications: multipart/report; report-type=
 * delivery-status) and RFC 8098 (disposition notifications), plus the common
 * Precedence and X-Autoreply headers.
 */
export type AutoMailReason = "auto_submitted" | "mailer_daemon" | "dsn" | "precedence" | "autoreply";

export interface AutoMailInput {
  /** Header name to value; names in any case. */
  headers?: Record<string, string | undefined> | null;
  /** The sender's address (or the raw From header). */
  from?: string | null;
  /** The top-level content type, when it is known apart from the headers. */
  contentType?: string | null;
}

const SYSTEM_SENDERS = new Set(["mailer-daemon", "postmaster"]);

function headerOf(headers: AutoMailInput["headers"], name: string): string {
  if (!headers) return "";
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return String(v ?? "").trim();
  return "";
}

/** The address inside "Name <a@b>" or a bare address. */
function addressOf(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1]! : from).trim().toLowerCase();
}

export function autoMailReason(input: AutoMailInput): AutoMailReason | null {
  const auto = headerOf(input.headers, "Auto-Submitted").toLowerCase();
  if (auto && auto !== "no") return "auto_submitted";

  const local = addressOf(String(input.from ?? headerOf(input.headers, "From"))).split("@")[0] ?? "";
  if (SYSTEM_SENDERS.has(local)) return "mailer_daemon";

  const ct = String(input.contentType || headerOf(input.headers, "Content-Type")).toLowerCase();
  if (ct.startsWith("multipart/report") && /report-type\s*=\s*"?(delivery-status|disposition-notification)/.test(ct)) return "dsn";

  const precedence = headerOf(input.headers, "Precedence").toLowerCase();
  if (precedence === "bulk" || precedence === "auto_reply" || precedence === "junk") return "precedence";

  if (headerOf(input.headers, "X-Autoreply") || headerOf(input.headers, "X-Autorespond")) return "autoreply";
  return null;
}

/** A raw header block ("Name: value" lines, folded lines continued) as name to value; the first of a repeated name wins. */
export function parseHeaderBlock(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const lines = String(raw).replace(/\r\n/g, "\n").split("\n");
  let last: string | null = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && last) { out[last] += " " + line.trim(); continue; }
    const i = line.indexOf(":");
    if (i <= 0) { last = null; continue; }
    const name = line.slice(0, i).trim();
    if (!(name in out)) { out[name] = line.slice(i + 1).trim(); last = name; } else last = null;
  }
  return out;
}
