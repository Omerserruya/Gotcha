/**
 * What an AI turn's tool calls leave on the message (metadata.toolCalls),
 * 2026-10-14: the tool and decision only, until "why did Maya not find the
 * order?" could not be answered. Now also WHAT it was called with and WHAT
 * came back, in a shape safe to keep:
 *   - args: emails and phone numbers masked (j***@gmail.com, ***0665); ids,
 *     numbers, booleans and short words kept; long text summarised by length;
 *     nested values not kept
 *   - result: a count for a list, the refusal / error reason for a failure,
 *     else just "ok": never the payload (it holds customers' records)
 *
 * No imports: services deep-import this file.
 */
export interface ToolCallRecord {
  tool: string;
  decision?: string;
  args?: Record<string, string | number | boolean | null>;
  resultCount?: number;
  resultError?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

const PHONE_KEY = /phone|mobile|tel|whatsapp|msisdn/i;

/** A phone, by its argument's name or its shape (+972…, 05x…, 054-…); an order id is not one. */
function looksLikePhone(key: string, s: string): boolean {
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7) return false;
  if (PHONE_KEY.test(key)) return true;
  return /^\+/.test(s) || (/^0\d/.test(s) && digits.length >= 9) || /\d[\s-]\d/.test(s);
}

function maskValue(key: string, v: unknown): string | number | boolean | null {
  if (v == null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return PHONE_KEY.test(key) ? `***${String(v).slice(-4)}` : v;
  if (typeof v !== "string") return "[value]";
  const s = v.trim();
  if (EMAIL.test(s)) return `${s[0]}***@${s.split("@")[1]}`;
  if (looksLikePhone(key, s)) return `***${s.replace(/\D/g, "").slice(-4)}`;
  return s.length <= 60 ? s : `[${s.length} chars]`;
}

export function toolCallRecord(tc: { tool: string; decision?: string; args?: unknown; result?: unknown }): ToolCallRecord {
  const out: ToolCallRecord = { tool: tc.tool, ...(tc.decision ? { decision: tc.decision } : {}) };
  if (tc.args && typeof tc.args === "object" && !Array.isArray(tc.args)) {
    const entries = Object.entries(tc.args as Record<string, unknown>).slice(0, 12);
    if (entries.length) out.args = Object.fromEntries(entries.map(([k, v]) => [k.slice(0, 40), maskValue(k, v)]));
  }
  let parsed: unknown = tc.result;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { parsed = tc.result; } }
  const inner = parsed && typeof parsed === "object" && !Array.isArray(parsed) && "result" in (parsed as any) ? (parsed as any).result : parsed;
  if (Array.isArray(inner)) out.resultCount = inner.length;
  else if (parsed && typeof parsed === "object" && ((parsed as any).ok === false || (parsed as any).error)) {
    out.resultError = String((parsed as any).reason ?? (parsed as any).error ?? "failed").slice(0, 120);
  }
  return out;
}
