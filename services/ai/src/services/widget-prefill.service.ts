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
  fetchImage?: (url: string, maxBytes: number) => Promise<Buffer | null>;
  upload?: (input: { authorization: string; tenantId: string; slot: WidgetImageSlot; bytes: Buffer; type: string }) => Promise<string | null>;
  model?: (input: { tenantId: string; messages: any[] }) => Promise<string>;
  ensure?: typeof ensureWebchat;
  put?: typeof putWidget;
  record?: (tenantId: string, value: unknown) => Promise<void>;
}

const HEX = /^#[0-9a-f]{6}$/;
const MIN_CONTRAST = 4.5;

function contrastWithWhite(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * r! + 0.7152 * g! + 0.0722 * b! + 0.05);
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

/** One image, fetched with the guard and checked against the widget upload's rules. */
async function vetImage(url: string, slot: WidgetImageSlot, fetchImage: NonNullable<PrefillDeps["fetchImage"]>) {
  if (!/^https:\/\//i.test(url)) return null; // the upload takes https links only
  const bytes = await fetchImage(url, WIDGET_IMAGE_LIMITS[slot].maxBytes).catch(() => null);
  if (!bytes) return null;
  const checked = checkWidgetImage(bytes, slot);
  if (!checked.ok) return null;
  return { url, bytes, type: checked.facts.type, width: checked.facts.width, height: checked.facts.height };
}

const defaultFetchImage: NonNullable<PrefillDeps["fetchImage"]> = async (url, maxBytes) => {
  const r = await safeFetchBuffer(url, { maxBytes, timeoutMs: 8_000, maxRedirects: 3 });
  return r.ok && r.buffer && !r.tooLarge ? r.buffer : null;
};

/** The same upload the widget editor uses (conversation POST /api/uploads/widget-image). */
const defaultUpload: NonNullable<PrefillDeps["upload"]> = async ({ authorization, tenantId, slot, bytes, type }) => {
  const base = (process.env.CONVERSATION_SERVICE_URL || "http://conversation:4002").replace(/\/$/, "");
  const form = new FormData();
  form.append("slot", slot);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: `image/${type}` }), `${slot}.${type === "jpeg" ? "jpg" : type}`);
  const res = await fetch(`${base}/api/uploads/widget-image`, {
    method: "POST",
    headers: { Authorization: authorization, "x-tenant-id": tenantId },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const body: any = await res.json().catch(() => null);
  return typeof body?.data?.url === "string" ? body.data.url : null;
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

function prompt(input: PrefillInput, lang: "he" | "en", logos: string[], heroes: string[], colors: string[]) {
  const language = lang === "he" ? "Hebrew" : "English";
  const c = input.context;
  return [
    "You design a website chat widget for a business, from its own site.",
    "You are shown candidate images, each labelled. Answer ONLY with JSON:",
    '{ "logo": label or null, "color": hex or null, "hero": label or null, "title": string or null, "assistantName": string or null, "suggestedQuestions": [3 strings] or null, "proactiveMessage": string or null }',
    "Rules:",
    "- logo: the label of the image that is clearly this business's logo or brand mark, readable when shown small. A product photo, a banner, a person or a generic icon is not a logo. Unsure: null.",
    "- color: one of the candidate colours ONLY if it plausibly is the brand's colour given the logo and the site (white text sits on it). Unsure: null.",
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
  ].filter(Boolean).join("\n");
}

export async function prefillWidget(input: PrefillInput, deps: PrefillDeps = {}): Promise<PrefillResult> {
  const fetchImage = deps.fetchImage ?? defaultFetchImage;
  const upload = deps.upload ?? defaultUpload;
  const model = deps.model ?? defaultModel;
  const ensure = deps.ensure ?? ensureWebchat;
  const put = deps.put ?? putWidget;
  const record = deps.record ?? ((tenantId, value) => writeDurableSetting(tenantId, AUTOFILL_SETTING, JSON.stringify(value), "widget-prefill").then(() => undefined));

  // The chat exists at the end of onboarding whatever happens below.
  const row = await ensure(input.tenantId);
  const current = normalizeWebchatConfig(row.credentials);
  const open = openFields(current);
  if (!open.size) return { status: "none", filled: {}, reason: "nothing_at_default" };

  const lang: "he" | "en" = input.language ?? (current.appearance.language === "he" ? "he" : "en");

  const wantLogo = open.has("appearance.logoUrl");
  const wantHero = open.has("ux.hero.mediaUrl");
  const logos = wantLogo ? (await Promise.all(input.logos.slice(0, 4).map((c) => vetImage(c.url, "logo", fetchImage)))).filter(Boolean) as NonNullable<Awaited<ReturnType<typeof vetImage>>>[] : [];
  const heroes = wantHero ? (await Promise.all(input.heroes.slice(0, 2).map((c) => vetImage(c.url, "cover", fetchImage)))).filter(Boolean) as NonNullable<Awaited<ReturnType<typeof vetImage>>>[] : [];
  // A hero must be wide: a square or tall image is no header background.
  const wideHeroes = heroes.filter((h) => h.width >= 600 && h.width >= h.height * 1.4);
  const colors = open.has("appearance.primaryColor")
    ? [...new Set(input.colors.map((c) => String(c.hex).toLowerCase()).filter((h) => HEX.test(h) && contrastWithWhite(h) >= MIN_CONTRAST))].slice(0, 4)
    : [];

  const hasBrand = logos.length + wideHeroes.length + colors.length > 0;
  const hasContext = !!(input.context.businessName || input.context.summary);
  // No brand and nothing learned about the business: the defaults stay.
  if (!hasBrand && !hasContext) return { status: "none", filled: {}, reason: "no_brand" };

  const logoLabels = logos.map((_, i) => `L${i}`);
  const heroLabels = wideHeroes.map((_, i) => `H${i}`);
  const content: any[] = [{ type: "text", text: prompt(input, lang, logoLabels, heroLabels, colors) }];
  logos.forEach((l, i) => {
    content.push({ type: "text", text: `Image L${i}:` });
    content.push({ type: "image_url", image_url: { url: `data:image/${l.type};base64,${l.bytes.toString("base64")}`, detail: "low" } });
  });
  wideHeroes.forEach((h, i) => {
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
    return { status: "failed", filled: {}, reason: err?.name === "AiUnitsExhaustedError" ? "units_refused" : "model_failed" };
  }

  const filled: Partial<Record<PrefillField, unknown>> = {};
  const patch: any = { appearance: {}, ux: {} };

  const color = typeof answer?.color === "string" ? answer.color.toLowerCase() : null;
  if (color && colors.includes(color)) { patch.appearance.primaryColor = color; filled["appearance.primaryColor"] = color; }

  const logo = typeof answer?.logo === "string" ? logos[logoLabels.indexOf(answer.logo)] : undefined;
  if (logo) {
    const url = await upload({ authorization: input.authorization, tenantId: input.tenantId, slot: "logo", bytes: logo.bytes, type: logo.type }).catch(() => null);
    if (url) { patch.appearance.logoUrl = url; filled["appearance.logoUrl"] = url; }
  }
  const hero = typeof answer?.hero === "string" ? wideHeroes[heroLabels.indexOf(answer.hero)] : undefined;
  if (hero) {
    const url = await upload({ authorization: input.authorization, tenantId: input.tenantId, slot: "cover", bytes: hero.bytes, type: hero.type }).catch(() => null);
    if (url) { patch.ux.hero = { mediaType: "image", mediaUrl: url }; filled["ux.hero.mediaUrl"] = url; }
  }

  if (input.language && open.has("appearance.language")) { patch.appearance.language = input.language; filled["appearance.language"] = input.language; }

  const welcome: any = {};
  const title = open.has("ux.welcome.title") ? cleanText(answer?.title, 60) : null;
  if (title) { welcome.title = title; filled["ux.welcome.title"] = title; }
  const name = open.has("ux.welcome.assistantName") ? cleanText(answer?.assistantName, 40) : null;
  if (name) { welcome.assistantName = name; filled["ux.welcome.assistantName"] = name; }
  if (open.has("ux.welcome.suggestedQuestions") && Array.isArray(answer?.suggestedQuestions)) {
    const qs = answer.suggestedQuestions.map((q: unknown) => cleanText(q, 80)).filter(Boolean);
    if (qs.length === 3) { welcome.suggestedQuestions = qs; filled["ux.welcome.suggestedQuestions"] = qs; }
  }
  if (Object.keys(welcome).length) patch.ux.welcome = welcome;
  const bubble = open.has("ux.proactive.message") ? cleanText(answer?.proactiveMessage, 200) : null;
  // Only the message: whether the bubble shows stays the merchant's choice (off).
  if (bubble) { patch.ux.proactive = { message: bubble }; filled["ux.proactive.message"] = bubble; }

  if (!Object.keys(filled).length) return { status: "none", filled: {}, reason: "model_unsure" };
  if (!Object.keys(patch.appearance).length) delete patch.appearance;
  if (!Object.keys(patch.ux).length) delete patch.ux;

  await put(input.tenantId, patch);
  await record(input.tenantId, { source: input.domain, at: new Date().toISOString(), fields: filled }).catch(() => {});
  console.log(`[widget-prefill] ${input.tenantId} filled ${Object.keys(filled).join(", ")}`);
  return { status: "done", filled };
}
