/**
 * Meta `template.components` for one send, and the text the customer will
 * read, from a MessageTemplate and the values for its placeholders.
 *
 * The same rules as the broadcast worker's copy (outgoing-worker
 * broadcast.worker.ts buildTemplateComponents): placeholder order as written,
 * `parameter_name` for named placeholders, and a blank value falls back to the
 * template's declared sample, then to "-", because Meta rejects empty text
 * (131008). Older private copies remain in the broadcast, scheduled and flow
 * code; new callers use this one.
 */
export interface TemplateLike {
  body?: string | null;
  headerType?: string | null;
  headerContent?: string | null;
  variables?: unknown;
}

/** `{{var}}` keys in order of first appearance. */
export function extractPlaceholders(text: string): string[] {
  const re = /\{\{\s*([\w-]+)\s*\}\}/g;
  const seen = new Set<string>();
  const order: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      order.push(m[1]);
    }
  }
  return order;
}

function valueLookup(tmpl: TemplateLike, values: Record<string, unknown> | undefined) {
  const declared = Array.isArray(tmpl.variables) ? (tmpl.variables as any[]) : [];
  const sampleByKey = new Map<string, string>();
  for (const v of declared) {
    if (v && typeof v.key === "string" && typeof v.sample === "string" && v.sample.trim()) sampleByKey.set(v.key, v.sample);
  }
  return (key: string): string => {
    const raw = values?.[key];
    if (raw != null && String(raw).length > 0) return String(raw);
    return sampleByKey.get(key) ?? "-";
  };
}

export function buildTemplateComponents(tmpl: TemplateLike, values?: Record<string, unknown>): any[] {
  const valueFor = valueLookup(tmpl, values);
  const component = (type: "header" | "body", text: string) => {
    const keys = extractPlaceholders(text);
    if (keys.length === 0) return null;
    if (keys.every((k) => /^\d+$/.test(k))) {
      return { type, parameters: [...keys].sort((a, b) => Number(a) - Number(b)).map((k) => ({ type: "text", text: valueFor(k) })) };
    }
    return { type, parameters: keys.map((k) => ({ type: "text", parameter_name: k, text: valueFor(k) })) };
  };
  const out: any[] = [];
  if (tmpl.headerType === "TEXT" && tmpl.headerContent) {
    const h = component("header", tmpl.headerContent);
    if (h) out.push(h);
  } else if ((tmpl.headerType === "IMAGE" || tmpl.headerType === "VIDEO" || tmpl.headerType === "DOCUMENT") && tmpl.headerContent) {
    const media = tmpl.headerType.toLowerCase();
    out.push({ type: "header", parameters: [{ type: media, [media]: { link: tmpl.headerContent } }] });
  }
  if (tmpl.body) {
    const b = component("body", tmpl.body);
    if (b) out.push(b);
  }
  return out;
}

/** The body as the customer reads it, placeholders filled the same way. */
export function renderTemplateText(tmpl: TemplateLike, values?: Record<string, unknown>): string {
  const valueFor = valueLookup(tmpl, values);
  return String(tmpl.body ?? "").replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, k) => valueFor(k));
}
