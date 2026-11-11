/**
 * The website widget, designed from the merchant's own site during the
 * onboarding scan (2026-11-11), so the chat is ready when onboarding ends.
 *
 * The auth scan hands over deterministic candidates (logo, colour and hero
 * URLs, the site's language) and what the scan learned about the business.
 * This:
 *   1. makes sure the workspace has its web chat (ensureWebchat);
 *   2. works out which fields are still at their defaults (the English
 *      default or the Hebrew seed copy). Nothing else is ever written;
 *   3. fetches each image candidate with the SSRF guard and the widget upload's
 *      own type and size rules (PNG, JPEG, GIF, WebP; never SVG);
 *   4. asks the vision model, in ONE call, to pick the logo, confirm the colour
 *      and the hero, and write the welcome copy in the site's language. Unsure
 *      means null, and null leaves the field as it is;
 *   5. copies the chosen images into our media store through the same upload
 *      the widget editor uses, so the widget never hotlinks the merchant's site;
 *   6. writes the filled fields through putWidget (web chat and any Shopify
 *      store chat alike) and records which ones it filled.
 *
 * Every failure (no units, the model, an upload) leaves the widget on its
 * defaults; nothing here may block onboarding.
 */
import {
  defaultWebchatConfig,
  normalizeWebchatConfig,
  webchatSeedConfig,
  writeDurableSetting,
  readDurableSetting,
  getInternalServiceKey,
  type WebchatConfig,
} from "@chatcenter/shared";
import { safeFetchBuffer } from "@chatcenter/shared/src/lib/safe-fetch";
import { checkWidgetImage, WIDGET_IMAGE_LIMITS, type WidgetImageSlot } from "@chatcenter/shared/src/lib/widget-image";
import { generateResponse, getDefaultModel } from "./ai.service";
import { ensureWebchat, putWidget } from "./website-widget.service";
import { withoutWideDashes } from "../lib/wide-dash";

export const AUTOFILL_SETTING = "widget.autofill";
export const PREFILL_AI_TYPE = "onboarding_widget_prefill";

export interface PrefillInput {
  tenantId: string;
  authorization: string;
  domain: string;
  language: "he" | "en" | null;
  logos: Array<{ url: string; source?: string }>;
  colors: Array<{ hex: string; source?: string }>;
  heroes: Array<{ url: string; source?: string }>;
  /**
   * The logo the widget already has, when its colour is still open: shown to
   * the model for the colour call only, never re-filled. Set by the fill.
   */
  storedLogoUrl?: string | null;
  context: {
    businessName?: string | null;
    summary?: string | null;
    products?: string | null;
    voice?: string | null;
    tone?: string | null;
    greetingExample?: string | null;
  };
}

export type PrefillField =
  | "appearance.primaryColor"
  | "appearance.logoUrl"
  | "appearance.language"
  | "ux.hero.mediaUrl"
  | "ux.welcome.title"
  | "ux.welcome.assistantName"
  | "ux.welcome.suggestedQuestions"
  | "ux.proactive.message";

export interface PrefillResult {
  status: "done" | "none" | "failed";
  filled: Partial<Record<PrefillField, unknown>>;
  reason?: string;
}

/** The deps a test replaces. */
export interface PrefillDeps {
  /** The widget's stored logo, read for the colour call (our own uploads, or a guarded fetch). */
  fetchStoredLogo?: (url: string) => Promise<Buffer | null>;
  /** The bytes, null when unreachable, "too_large" past the cap. */
  fetchImage?: (url: string, maxBytes: number) => Promise<Buffer | null | "too_large">;
  upload?: (input: { authorization: string; tenantId: string; slot: WidgetImageSlot; bytes: Buffer; type: string }) => Promise<string | null>;
  model?: (input: { tenantId: string; messages: any[] }) => Promise<string>;
  ensure?: typeof ensureWebchat;
  put?: typeof putWidget;
  record?: (tenantId: string, value: unknown) => Promise<void>;
}

const HEX = /^#[0-9a-f]{6}$/;
const MIN_CONTRAST = 4.5;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/**
 * How well the widget's own text reads on this colour: it writes cream
 * #FBF8F3 or ink #2B2622, whichever contrasts more (inkOn() in the widget
 * bundles), so a pale brand gets dark text, not a darkened brand.
 */
function inkContrast(hex: string): number {
  const l = luminance(hex);
  return Math.max((luminance("#fbf8f3") + 0.05) / (l + 0.05), (l + 0.05) / (luminance("#2b2622") + 0.05));
}

const get = (o: any, path: string) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), o);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The fields still at a default: equal to the English default or to the
 * Hebrew seed (a Hebrew workspace's widget starts with that copy). A field the
 * merchant changed is never in this list.
 */
export function openFields(current: WebchatConfig): Set<PrefillField> {
  const defaults = [defaultWebchatConfig(), normalizeWebchatConfig(webchatSeedConfig("he"))];
  const fields: PrefillField[] = [
    "appearance.primaryColor", "appearance.logoUrl", "appearance.language", "ux.hero.mediaUrl",
    "ux.welcome.title", "ux.welcome.assistantName", "ux.welcome.suggestedQuestions", "ux.proactive.message",
  ];
  const open = new Set<PrefillField>();
  for (const f of fields) {
    const v = get(current, f);
    if (defaults.some((d) => same(get(d, f), v))) open.add(f);
  }
  // A hero is open only while the widget shows none at all.
  if (current.ux.hero.mediaType !== "none") open.delete("ux.hero.mediaUrl");
  return open;
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = withoutWideDashes(v).replace(/\s+/g, " ").trim();
  if (!t || t.length > max) return null;
  return t;
}

export interface VettedImage { url: string; bytes: Buffer; type: string; width: number; height: number }
/** Why a candidate was left out: a fixed list, shared with auth's extractor. */
export type RejectionReason =
  | "not_https" | "unreachable" | "too_large" | "dimensions_too_large" | "not_an_image" | "wrong_ratio"
  | "not_a_color" | "low_contrast" | "neutral" | "duplicate" | "over_cap" | "field_already_set" | "model_unsure" | "model_chose_another";
export interface Rejection { kind: "logo" | "hero" | "color"; value: string; source?: string; reason: RejectionReason; detail?: string }

/**
 * A grey, white or black: never a brand colour taken from a logo. Saturation
 * under 25% (HSL), or lightness outside 8% to 92%.
 */
export function isNeutral(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (l < 0.08 || l > 0.92 || max === min) return true;
  const s = l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  return s < 0.25;
}

/** One image, fetched with the guard and checked against the widget upload's rules, or why not. */
const CHECK_REASON: Record<string, RejectionReason> = { IMAGE_TOO_LARGE: "too_large", IMAGE_DIMENSIONS_TOO_LARGE: "dimensions_too_large", NOT_AN_IMAGE: "not_an_image" };

async function vetImage(url: string, slot: WidgetImageSlot, fetchImage: NonNullable<PrefillDeps["fetchImage"]>): Promise<VettedImage | { rejected: RejectionReason; detail?: string }> {
  if (!/^https:\/\//i.test(url)) return { rejected: "not_https" }; // the upload takes https links only
  const bytes = await fetchImage(url, WIDGET_IMAGE_LIMITS[slot].maxBytes).catch(() => null);
  if (bytes === "too_large") return { rejected: "too_large", detail: `over ${WIDGET_IMAGE_LIMITS[slot].maxBytes} bytes` };
  if (!bytes) return { rejected: "unreachable" };
  const checked = checkWidgetImage(bytes, slot);
  if (!checked.ok) {
    const detail = checked.code === "IMAGE_DIMENSIONS_TOO_LARGE" ? `${checked.width}x${checked.height}, at most ${checked.maxWidth}x${checked.maxHeight}` : undefined;
    return { rejected: CHECK_REASON[checked.code] ?? "not_an_image", detail };
  }
  return { url, bytes, type: checked.facts.type, width: checked.facts.width, height: checked.facts.height };
}

const defaultFetchImage: NonNullable<PrefillDeps["fetchImage"]> = async (url, maxBytes) => {
  const r = await safeFetchBuffer(url, { maxBytes, timeoutMs: 8_000, maxRedirects: 3 });
  if (r.tooLarge) return "too_large";
  return r.ok && r.buffer ? r.buffer : null;
};

/**
 * The copy into our media store: conversation's internal twin of the widget
 * editor's upload (same check, same storage). The merchant route needs the
 * paid product, and a tenant in onboarding is not ACTIVE yet (dev walk,
 * 2026-11-11: every onboarding copy was refused there).
 */
const defaultUpload: NonNullable<PrefillDeps["upload"]> = async ({ tenantId, slot, bytes, type }) => {
  const base = (process.env.CONVERSATION_SERVICE_URL || "http://conversation:4002").replace(/\/$/, "");
  const form = new FormData();
  form.append("slot", slot);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: `image/${type}` }), `${slot}.${type === "jpeg" ? "jpg" : type}`);
  const res = await fetch(`${base}/api/uploads/widget-image/internal`, {
    method: "POST",
    headers: { "X-Internal-Key": getInternalServiceKey(), "x-tenant-id": tenantId },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const why: any = await res.json().catch(() => null);
    console.warn(`[widget-prefill] ${tenantId} ${slot} copy refused: ${res.status} ${why?.code ?? ""}`.trim());
    return null;
  }
  const body: any = await res.json().catch(() => null);
  return typeof body?.data?.url === "string" ? body.data.url : null;
};

const OWN_UPLOAD = /^\/api\/uploads\/widget\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;

/**
 * The stored logo's bytes. Our own upload (the widget editor's or the fill's)
 * is read from conversation inside the network; any other link only through
 * the SSRF guard. Capped at the logo slot's bytes either way.
 */
const defaultFetchStoredLogo: NonNullable<PrefillDeps["fetchStoredLogo"]> = async (url) => {
  const max = WIDGET_IMAGE_LIMITS.logo.maxBytes;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (OWN_UPLOAD.test(u.pathname)) {
    const base = (process.env.CONVERSATION_SERVICE_URL || "http://conversation:4002").replace(/\/$/, "");
    const res = await fetch(`${base}${u.pathname}`, { signal: AbortSignal.timeout(8_000) }).catch(() => null);
    if (!res?.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= max ? buf : null;
  }
  const r = await safeFetchBuffer(url, { maxBytes: max, timeoutMs: 8_000, maxRedirects: 3 });
  return r.ok && r.buffer && !r.tooLarge ? r.buffer : null;
};

const defaultModel: NonNullable<PrefillDeps["model"]> = async ({ tenantId, messages }) => {
  const r = await generateResponse({
    tenantId,
    model: getDefaultModel(),
    temperature: 0.2,
    maxTokens: 1200,
    responseFormat: { type: "json_object" },
    metadata: { type: PREFILL_AI_TYPE },
    messages,
  });
  return r.content;
};

function prompt(input: PrefillInput, lang: "he" | "en", logos: string[], heroes: string[], colors: string[], storedLogo = false) {
  const language = lang === "he" ? "Hebrew" : "English";
  const c = input.context;
  return [
    "You design a website chat widget for a business, from its own site.",
    "You are shown candidate images, each labelled. Answer ONLY with JSON:",
    '{ "logo": label or null, "color": hex or null, "logoColor": hex or null, "hero": label or null, "title": string or null, "assistantName": string or null, "suggestedQuestions": [3 strings] or null, "proactiveMessage": string or null }',
    "Rules:",
    "- logo: the label of the image that is clearly this business's logo or brand mark, readable when shown small. A product photo, a banner, a person or a generic icon is not a logo. Unsure: null.",
    "- color: one of the candidate colours ONLY if it plausibly is the brand's colour given the logo and the site (the widget writes cream or dark text on it, whichever reads). Unsure: null.",
    '- logoColor: ONLY when "color" is null and there is a logo (the one you chose, or image S0): that logo\'s dominant colour that is not white, black or grey, as "#rrggbb", read from the logo image itself. No clear brand colour in the logo: null.',
    "- hero: the label of a wide image that works as a calm background behind a header, with no text baked in and nothing important at the edges. Unsure: null.",
    `- The texts are in ${language}, in the business's own voice, short and plain. No em dash, no en dash. Never invent facts, prices or offers.`,
    "- title: the chat's welcome headline, at most 40 characters.",
    "- assistantName: a short team name for the chat header (for example the store's name plus \"team\"), at most 30 characters.",
    "- suggestedQuestions: exactly 3 questions a visitor of THIS business would ask, each at most 60 characters.",
    "- proactiveMessage: one inviting line shown in a bubble, at most 120 characters.",
    "",
    `Site: ${input.domain}`,
    c.businessName ? `Business: ${c.businessName}` : "",
    c.summary ? `What it does: ${String(c.summary).slice(0, 600)}` : "",
    c.products ? `Products: ${String(c.products).slice(0, 400)}` : "",
    c.voice ? `Voice: ${String(c.voice).slice(0, 300)}` : "",
    c.tone ? `Tone: ${String(c.tone).slice(0, 200)}` : "",
    c.greetingExample ? `Greeting in its voice: ${String(c.greetingExample).slice(0, 200)}` : "",
    `Logo candidates: ${logos.length ? logos.join(", ") : "none"}`,
    `Hero candidates: ${heroes.length ? heroes.join(", ") : "none"}`,
    `Colour candidates: ${colors.length ? colors.join(", ") : "none"}`,
    storedLogo ? "The business already has a logo (image S0). Judge the colour against it; logoColor may come from it." : "",
  ].filter(Boolean).join("\n");
}

/** What the model chose, after every check: the values a fill would write (images still as bytes). */
export interface PrefillPlan {
  status: "planned" | "none" | "failed";
  reason?: string;
  color: string | null;
  /** Where the colour came from: a value on the site, or (when none fitted) the chosen logo. */
  colorSource: "site" | "logo" | null;
  logo: VettedImage | null;
  hero: VettedImage | null;
  language: "he" | "en" | null;
  title: string | null;
  assistantName: string | null;
  suggestedQuestions: string[] | null;
  proactiveMessage: string | null;
  /** Every candidate left out, and why. */
  rejected: Rejection[];
  /** What the model answered, verbatim (the preview shows it). */
  answer: unknown;
}

const emptyPlan = (status: PrefillPlan["status"], reason: string, rejected: Rejection[] = [], answer: unknown = null): PrefillPlan => ({
  status, reason, color: null, colorSource: null, logo: null, hero: null, language: null, title: null, assistantName: null,
  suggestedQuestions: null, proactiveMessage: null, rejected, answer,
});

/**
 * The decision, shared by the fill and the preview: vet the candidates, ask
 * the model once, keep only answers that pass. No writes of any kind.
 */
export async function planPrefill(input: PrefillInput, open: Set<PrefillField>, deps: Pick<PrefillDeps, "fetchImage" | "model" | "fetchStoredLogo"> = {}): Promise<PrefillPlan> {
  const fetchImage = deps.fetchImage ?? defaultFetchImage;
  const fetchStoredLogo = deps.fetchStoredLogo ?? defaultFetchStoredLogo;
  const model = deps.model ?? defaultModel;
  const rejected: Rejection[] = [];
  const lang: "he" | "en" = input.language ?? "en";

  const vetAll = async (list: Array<{ url: string; source?: string }>, slot: WidgetImageSlot, kind: "logo" | "hero", want: boolean, cap: number) => {
    const out: VettedImage[] = [];
    if (!want) { for (const c of list) rejected.push({ kind, value: c.url, source: c.source, reason: "field_already_set" }); return out; }
    for (const [i, c] of list.entries()) {
      if (i >= cap) { rejected.push({ kind, value: c.url, source: c.source, reason: "over_cap" }); continue; }
      const v = await vetImage(c.url, slot, fetchImage);
      if ("rejected" in v) { rejected.push({ kind, value: c.url, source: c.source, reason: v.rejected, ...(v.detail ? { detail: v.detail } : {}) }); continue; }
      // A hero must be wide: a square or tall image is no header background.
      if (kind === "hero" && !(v.width >= 600 && v.width >= v.height * 1.4)) { rejected.push({ kind, value: c.url, source: c.source, reason: "wrong_ratio", detail: `${v.width}x${v.height}, a hero needs at least 600px wide and 1.4:1` }); continue; }
      out.push(v);
    }
    return out;
  };
  const logos = await vetAll(input.logos, "logo", "logo", open.has("appearance.logoUrl"), 4);
  const heroes = await vetAll(input.heroes, "cover", "hero", open.has("ux.hero.mediaUrl"), 2);
  const colors: string[] = [];
  for (const c of input.colors) {
    const hex = String(c.hex).toLowerCase();
    const reason: RejectionReason | null = !open.has("appearance.primaryColor") ? "field_already_set"
      : !HEX.test(hex) ? "not_a_color"
      : inkContrast(hex) < MIN_CONTRAST ? "low_contrast"
      : colors.includes(hex) ? "duplicate"
      : colors.length >= 4 ? "over_cap" : null;
    if (reason) rejected.push({ kind: "color", value: hex, source: c.source, reason });
    else colors.push(hex);
  }

  // The logo is already set but the colour is open: the model sees the stored
  // logo for the colour call (dev 2026-11-11: without it, a button yellow was
  // accepted for a navy and green brand).
  let stored: VettedImage | null = null;
  if (input.storedLogoUrl && !open.has("appearance.logoUrl") && open.has("appearance.primaryColor")) {
    const bytes = await fetchStoredLogo(input.storedLogoUrl).catch(() => null);
    const checked = bytes ? checkWidgetImage(bytes, "logo") : null;
    if (bytes && checked?.ok) stored = { url: input.storedLogoUrl, bytes, type: checked.facts.type, width: checked.facts.width, height: checked.facts.height };
  }

  const hasBrand = logos.length + heroes.length + colors.length > 0;
  const hasContext = !!(input.context.businessName || input.context.summary);
  // No brand and nothing learned about the business: the defaults stay.
  if (!hasBrand && !hasContext) return emptyPlan("none", "no_brand", rejected);

  const logoLabels = logos.map((_, i) => `L${i}`);
  const heroLabels = heroes.map((_, i) => `H${i}`);
  const content: any[] = [{ type: "text", text: prompt(input, lang, logoLabels, heroLabels, colors, !!stored) }];
  if (stored) {
    content.push({ type: "text", text: "Image S0 (the business's logo, already set; for the colour only, never a logo answer):" });
    content.push({ type: "image_url", image_url: { url: `data:image/${stored.type};base64,${stored.bytes.toString("base64")}`, detail: "low" } });
  }
  logos.forEach((l, i) => {
    content.push({ type: "text", text: `Image L${i}:` });
    content.push({ type: "image_url", image_url: { url: `data:image/${l.type};base64,${l.bytes.toString("base64")}`, detail: "low" } });
  });
  heroes.forEach((h, i) => {
    content.push({ type: "text", text: `Image H${i}:` });
    content.push({ type: "image_url", image_url: { url: `data:image/${h.type};base64,${h.bytes.toString("base64")}`, detail: "low" } });
  });

  let answer: any;
  try {
    const raw = await model({ tenantId: input.tenantId, messages: [{ role: "user", content }] });
    answer = JSON.parse(raw);
  } catch (err: any) {
    // A units refusal lands here too: the widget keeps its defaults.
    console.warn(`[widget-prefill] ${input.tenantId} model step failed: ${err?.name ?? ""} ${err?.message ?? err}`);
    return emptyPlan("failed", err?.name === "AiUnitsExhaustedError" ? "units_refused" : "model_failed", rejected);
  }

  const pickedColor = typeof answer?.color === "string" ? answer.color.toLowerCase() : null;
  const color = pickedColor && colors.includes(pickedColor) ? pickedColor : null;
  for (const c of colors) if (c !== color) rejected.push({ kind: "color", value: c, reason: pickedColor === null ? "model_unsure" : "model_chose_another" });
  const logo = typeof answer?.logo === "string" ? logos[logoLabels.indexOf(answer.logo)] ?? null : null;
  for (const l of logos) if (l !== logo) rejected.push({ kind: "logo", value: l.url, reason: logo ? "model_chose_another" : "model_unsure" });

  // No site colour fitted: the chosen logo's own colour, if the model names
  // one and it passes the same rule (Omer, 2026-11-11: drcomfort's only site
  // colour was its button yellow, its logo navy and green).
  let fromLogo: string | null = null;
  const logoColor = typeof answer?.logoColor === "string" ? answer.logoColor.trim().toLowerCase() : null;
  if (!color && (logo || stored) && logoColor && open.has("appearance.primaryColor")) {
    const reason: RejectionReason | null = !HEX.test(logoColor) ? "not_a_color"
      : isNeutral(logoColor) ? "neutral"
      : inkContrast(logoColor) < MIN_CONTRAST ? "low_contrast" : null;
    if (reason) rejected.push({ kind: "color", value: logoColor, source: "logo", reason });
    else fromLogo = logoColor;
  }
  const hero = typeof answer?.hero === "string" ? heroes[heroLabels.indexOf(answer.hero)] ?? null : null;
  for (const h of heroes) if (h !== hero) rejected.push({ kind: "hero", value: h.url, reason: hero ? "model_chose_another" : "model_unsure" });

  const qs = open.has("ux.welcome.suggestedQuestions") && Array.isArray(answer?.suggestedQuestions)
    ? answer.suggestedQuestions.map((q: unknown) => cleanText(q, 80)).filter(Boolean) as string[]
    : [];
  return {
    status: "planned",
    color: color ?? fromLogo,
    colorSource: color ? "site" : fromLogo ? "logo" : null,
    logo,
    hero,
    language: input.language && open.has("appearance.language") ? input.language : null,
    title: open.has("ux.welcome.title") ? cleanText(answer?.title, 60) : null,
    assistantName: open.has("ux.welcome.assistantName") ? cleanText(answer?.assistantName, 40) : null,
    suggestedQuestions: qs.length === 3 ? qs : null,
    // Only the message: whether the bubble shows stays the merchant's choice (off).
    proactiveMessage: open.has("ux.proactive.message") ? cleanText(answer?.proactiveMessage, 200) : null,
    rejected,
    answer,
  };
}

/** The plan as a widget patch, with the image URLs supplied by the caller. */
function patchOf(plan: PrefillPlan, images: { logo: string | null; hero: string | null }) {
  const filled: Partial<Record<PrefillField, unknown>> = {};
  const patch: any = { appearance: {}, ux: {} };
  if (plan.color) { patch.appearance.primaryColor = plan.color; filled["appearance.primaryColor"] = plan.color; }
  if (images.logo) { patch.appearance.logoUrl = images.logo; filled["appearance.logoUrl"] = images.logo; }
  if (images.hero) { patch.ux.hero = { mediaType: "image", mediaUrl: images.hero }; filled["ux.hero.mediaUrl"] = images.hero; }
  if (plan.language) { patch.appearance.language = plan.language; filled["appearance.language"] = plan.language; }
  const welcome: any = {};
  if (plan.title) { welcome.title = plan.title; filled["ux.welcome.title"] = plan.title; }
  if (plan.assistantName) { welcome.assistantName = plan.assistantName; filled["ux.welcome.assistantName"] = plan.assistantName; }
  if (plan.suggestedQuestions) { welcome.suggestedQuestions = plan.suggestedQuestions; filled["ux.welcome.suggestedQuestions"] = plan.suggestedQuestions; }
  if (Object.keys(welcome).length) patch.ux.welcome = welcome;
  if (plan.proactiveMessage) { patch.ux.proactive = { message: plan.proactiveMessage }; filled["ux.proactive.message"] = plan.proactiveMessage; }
  if (!Object.keys(patch.appearance).length) delete patch.appearance;
  if (!Object.keys(patch.ux).length) delete patch.ux;
  return { patch, filled };
}

export async function prefillWidget(input: PrefillInput, deps: PrefillDeps = {}): Promise<PrefillResult> {
  const started = Date.now();
  const result = await prefillWidgetOnce(input, deps);
  console.log(`[widget-prefill] ${input.tenantId} ${result.status}${result.reason ? ` (${result.reason})` : ""} in ${Date.now() - started}ms`);
  return result;
}

async function prefillWidgetOnce(input: PrefillInput, deps: PrefillDeps): Promise<PrefillResult> {
  const upload = deps.upload ?? defaultUpload;
  const ensure = deps.ensure ?? ensureWebchat;
  const put = deps.put ?? putWidget;
  const record = deps.record ?? recordAutofill;

  // The chat exists at the end of onboarding whatever happens below.
  const row = await ensure(input.tenantId);
  const current = normalizeWebchatConfig(row.credentials);
  const open = openFields(current);
  if (!open.size) return { status: "none", filled: {}, reason: "nothing_at_default" };
  // The site's language when it said; else the widget's own.
  const plan = await planPrefill({ ...input, storedLogoUrl: current.appearance.logoUrl }, open, deps);
  if (plan.rejected.length) {
    console.log(`[widget-prefill] ${input.tenantId} left out: ${plan.rejected.map((r) => `${r.kind}:${r.reason}`).join(", ")}`);
  }
  if (plan.status !== "planned") return { status: plan.status, filled: {}, reason: plan.reason };

  const copy = async (img: VettedImage | null, slot: WidgetImageSlot) =>
    img ? upload({ authorization: input.authorization, tenantId: input.tenantId, slot, bytes: img.bytes, type: img.type }).catch((err: any) => {
      console.warn(`[widget-prefill] ${input.tenantId} ${slot} copy failed: ${err?.message ?? err}`);
      return null;
    }) : null;
  // An upload that fails leaves that image unset: never the hotlink.
  const { patch, filled } = patchOf(plan, { logo: await copy(plan.logo, "logo"), hero: await copy(plan.hero, "cover") });
  if (!Object.keys(filled).length) return { status: "none", filled: {}, reason: "model_unsure" };

  await put(input.tenantId, patch);
  const sources = plan.colorSource && filled["appearance.primaryColor"] ? { "appearance.primaryColor": plan.colorSource } : {};
  await record(input.tenantId, { source: input.domain, at: new Date().toISOString(), fields: filled, sources }).catch(() => {});
  console.log(`[widget-prefill] ${input.tenantId} filled ${Object.keys(filled).map((f) => (f === "appearance.primaryColor" && plan.colorSource ? `${f} (from ${plan.colorSource})` : f)).join(", ")}`);
  return { status: "done", filled };
}

/**
 * The record of what the scan filled, MERGED with what an earlier scan
 * filled: a second scan fills only fields still at default, and replacing
 * the record dropped the first scan's fields from it (dev, 2026-11-11).
 */
export function mergeAutofill(previous: unknown, next: { source: string; at: string; fields: Record<string, unknown>; sources?: Record<string, string> }) {
  let prev: any = previous;
  if (typeof prev === "string") { try { prev = JSON.parse(prev); } catch { prev = null; } }
  if (typeof prev === "string") { try { prev = JSON.parse(prev); } catch { prev = null; } }
  const fields = prev && typeof prev.fields === "object" && prev.fields ? { ...prev.fields } : {};
  const sources = prev && typeof prev.sources === "object" && prev.sources ? { ...prev.sources } : {};
  // A field filled again without a stated source no longer has the old one.
  for (const f of Object.keys(next.fields)) delete sources[f];
  return { source: next.source, at: next.at, fields: { ...fields, ...next.fields }, sources: { ...sources, ...(next.sources ?? {}) } };
}

async function recordAutofill(tenantId: string, value: unknown): Promise<void> {
  const previous = await readDurableSetting(tenantId, AUTOFILL_SETTING).catch(() => null);
  await writeDurableSetting(tenantId, AUTOFILL_SETTING, JSON.stringify(mergeAutofill(previous, value as any)), "widget-prefill");
}

/** Every field the fill may write: the preview shows a widget as if all were still at default. */
export const ALL_PREFILL_FIELDS: ReadonlySet<PrefillField> = new Set<PrefillField>([
  "appearance.primaryColor", "appearance.logoUrl", "appearance.language", "ux.hero.mediaUrl",
  "ux.welcome.title", "ux.welcome.assistantName", "ux.welcome.suggestedQuestions", "ux.proactive.message",
]);

export interface PrefillPreview {
  status: PrefillPlan["status"];
  colorSource: PrefillPlan["colorSource"];
  reason?: string;
  /** The full widget config the fill WOULD write on a fresh widget; images at their https source (a real fill stores our copy). */
  config: WebchatConfig;
  /** The fields it would fill. */
  filled: PrefillField[];
  images: {
    logo: { dataUrl: string; sourceUrl: string; type: string; width: number; height: number } | null;
    hero: { dataUrl: string; sourceUrl: string; type: string; width: number; height: number } | null;
  };
  rejected: Rejection[];
  answer: unknown;
}

/**
 * The dry run (Omer, 2026-11-11): the same vetting and vision call as the
 * fill, with NO side effect: no web chat created, no widget written, no image
 * uploaded, no setting recorded. The images come back as data: URLs from the
 * vetted bytes (already within the upload's limits), so a page shows them
 * without loading the merchant's host.
 */
export async function previewWidget(input: PrefillInput, deps: Pick<PrefillDeps, "fetchImage" | "model"> = {}): Promise<PrefillPreview> {
  const plan = await planPrefill(input, new Set(ALL_PREFILL_FIELDS), deps);
  const asData = (img: VettedImage | null) => img
    ? { dataUrl: `data:image/${img.type};base64,${img.bytes.toString("base64")}`, sourceUrl: img.url, type: img.type, width: img.width, height: img.height }
    : null;
  const images = { logo: asData(plan.logo), hero: asData(plan.hero) };
  const base = normalizeWebchatConfig(input.language === "he" ? webchatSeedConfig("he") : {});
  // The widget bundle loads only http(s) images, so the config the preview
  // renders carries the source URL; the data: copies are for thumbnails.
  // A platform admin's own browser loads them, never a merchant's visitors.
  const { patch, filled } = patchOf(plan, { logo: images.logo?.sourceUrl ?? null, hero: images.hero?.sourceUrl ?? null });
  const config: WebchatConfig = {
    ...base,
    appearance: { ...base.appearance, ...(patch.appearance ?? {}) },
    ux: {
      ...base.ux,
      hero: { ...base.ux.hero, ...(patch.ux?.hero ?? {}) },
      welcome: { ...base.ux.welcome, ...(patch.ux?.welcome ?? {}) },
      proactive: { ...base.ux.proactive, ...(patch.ux?.proactive ?? {}) },
    },
  };
  return { status: plan.status, colorSource: plan.colorSource, reason: plan.reason, config, filled: Object.keys(filled) as PrefillField[], images, rejected: plan.rejected, answer: plan.answer };
}

// ── the console preview's answer (shape agreed with the frontend, 2026-11-11) ──

export type PreviewField = "logo" | "color" | "hero" | "title" | "assistantName" | "questions" | "proactiveMessage" | "language";
const FIELD_OF_KIND: Record<"logo" | "hero" | "color", PreviewField> = { logo: "logo", hero: "hero", color: "color" };

export interface PreviewResponse {
  url: string;
  business: string | null;
  status: PrefillPlan["status"];
  reason: string | null;
  /** The GET /api/website-widget settings shape, every field the fill would write applied. */
  settings: {
    appearance: WebchatConfig["appearance"];
    ux: WebchatConfig["ux"];
    handoff: { allowHumanHandoff: boolean };
    offline: { message: string };
    commerce: WebchatConfig["commerce"];
    nameSource: WebchatConfig["nameSource"];
  };
  found: Array<{ field: PreviewField; value: string; src: string | null; dataUrl: string | null; from: string | null }>;
  rejected: Array<{ field: PreviewField; candidate: string; reason: string; detail: string | null }>;
}

/** Auth's candidates (and their reasons) plus the preview, as the console reads them. */
export function previewResponse(
  read: { url: string; candidates: { logos: any[]; heroes: any[]; colors: any[]; rejected?: any[] }; context: { businessName?: string | null } },
  p: PrefillPreview,
): PreviewResponse {
  const c = p.config;
  const sourceOf = (url: string | undefined, list: any[]) => (url ? list.find((x) => x.url === url)?.source ?? null : null);
  const found: PreviewResponse["found"] = [];
  if (p.images.logo) found.push({ field: "logo", value: p.images.logo.sourceUrl, src: p.images.logo.sourceUrl, dataUrl: p.images.logo.dataUrl, from: sourceOf(p.images.logo.sourceUrl, read.candidates.logos) });
  if (p.filled.includes("appearance.primaryColor")) {
    const cand = read.candidates.colors.find((x) => String(x.hex).toLowerCase() === c.appearance.primaryColor);
    const from = p.colorSource === "logo" ? "logo (read by the model)"
      : cand ? `${cand.source}${cand.original && cand.original !== cand.hex ? ` (was ${cand.original}, darkened so text reads)` : ""}` : null;
    found.push({ field: "color", value: c.appearance.primaryColor, src: null, dataUrl: null, from });
  }
  if (p.images.hero) found.push({ field: "hero", value: p.images.hero.sourceUrl, src: p.images.hero.sourceUrl, dataUrl: p.images.hero.dataUrl, from: sourceOf(p.images.hero.sourceUrl, read.candidates.heroes) });
  const text = (field: PreviewField, path: PrefillField, value: string) => { if (p.filled.includes(path)) found.push({ field, value, src: null, dataUrl: null, from: "model" }); };
  text("title", "ux.welcome.title", c.ux.welcome.title);
  text("assistantName", "ux.welcome.assistantName", c.ux.welcome.assistantName);
  text("questions", "ux.welcome.suggestedQuestions", c.ux.welcome.suggestedQuestions.join("\n"));
  text("proactiveMessage", "ux.proactive.message", c.ux.proactive.message);
  if (p.filled.includes("appearance.language")) found.push({ field: "language", value: c.appearance.language, src: null, dataUrl: null, from: "html lang" });

  const rejected: PreviewResponse["rejected"] = [
    ...(read.candidates.rejected ?? []).map((r: any) => ({ field: FIELD_OF_KIND[r.kind as "logo"] ?? "logo", candidate: String(r.value).slice(0, 200), reason: String(r.reason), detail: r.source ? `from ${r.source}` : null })),
    ...p.rejected.map((r) => ({ field: FIELD_OF_KIND[r.kind], candidate: r.value.slice(0, 200), reason: r.reason, detail: r.detail ?? null })),
  ];
  return {
    url: read.url,
    business: read.context.businessName ?? null,
    status: p.status,
    reason: p.reason ?? null,
    settings: { appearance: c.appearance, ux: c.ux, handoff: { allowHumanHandoff: c.behaviour.allowHumanHandoff }, offline: { message: c.offline.message }, commerce: c.commerce, nameSource: c.nameSource },
    found,
    rejected,
  };
}
