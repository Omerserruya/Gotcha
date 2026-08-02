/**
 * The shape of a business-discovery record, enforced at the boundary.
 *
 * `BusinessDiscovery.technology` and `.communication` are Prisma `Json`
 * columns, so the database enforces nothing and the TypeScript types that
 * describe them are a promise nobody keeps. They are written from several
 * places at different points in a scan:
 *
 *   - the canonical LLM synthesis, which writes all four collections;
 *   - the deterministic mid-scan checkpoint, which historically wrote only
 *     `platform` and `tools` and is deliberately left in place as the
 *     honest fallback when the LLM step fails;
 *   - the one-tap correction path, which rewrites whatever it was handed.
 *
 * So a perfectly ordinary tenant - one whose scan is still running, or
 * whose synthesis failed - ends up with `{ platform, tools }` and no
 * `legacy` or `tracking`, while every consumer's type insists all four
 * are arrays. That is what crashed the setup page on `tech.legacy.length`.
 *
 * The fix is one normalizer applied wherever the record crosses a
 * boundary, so a reader is never handed a half-object. Malformed ENTRIES
 * are dropped rather than coerced: an item with no usable name cannot be
 * rendered, and inventing a placeholder would put a technology in front
 * of a customer that their scan never found.
 */

export type DiscoveryConfidence =
  | "confirmed"
  | "likely"
  | "low"
  | "needs_verification"
  | "unknown";

export interface DiscoveryTechItem {
  slug: string;
  name: string;
  category?: string;
  confidence?: DiscoveryConfidence;
}

export interface DiscoveryPlatform {
  slug: string;
  name: string;
  confidence: DiscoveryConfidence;
}

export interface DiscoveryTechnology {
  platform: DiscoveryPlatform | null;
  legacy: DiscoveryTechItem[];
  tracking: DiscoveryTechItem[];
  tools: DiscoveryTechItem[];
}

export interface DiscoveryChannel {
  type: string;
  identifier?: string;
  purpose?: string;
  provider?: string;
  confidence: DiscoveryConfidence;
}

export interface DiscoveryCommunication {
  channels: DiscoveryChannel[];
}

/** Every collection on the technology object. Keeping the list in one place
 *  means adding a fifth cannot be forgotten by one of the writers. */
export const DISCOVERY_TECH_COLLECTIONS = ["legacy", "tracking", "tools"] as const;

const CONFIDENCES: DiscoveryConfidence[] = [
  "confirmed",
  "likely",
  "low",
  "needs_verification",
  "unknown",
];

function confidence(raw: unknown, fallback: DiscoveryConfidence = "unknown"): DiscoveryConfidence {
  return typeof raw === "string" && (CONFIDENCES as string[]).includes(raw)
    ? (raw as DiscoveryConfidence)
    : fallback;
}

function text(raw: unknown, max = 80): string {
  if (typeof raw !== "string") return "";
  // Control characters and angle brackets: this text is rendered, and the
  // record is assembled partly from a third-party page's own markup.
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** A slug is used to build an icon URL, so it may only be url-safe. */
function slug(raw: unknown): string {
  const v = text(raw, 60).toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*$/.test(v) ? v : "";
}

/**
 * One detected technology.
 *
 * Requires a NAME, because that is what a customer reads. A missing slug
 * only costs the icon, so the item is kept and the icon is skipped;
 * dropping the whole row would hide a real finding over a cosmetic gap.
 */
function techItem(raw: unknown): DiscoveryTechItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name) || text(r.slug);
  if (!name) return null;
  const item: DiscoveryTechItem = { slug: slug(r.slug), name };
  const category = text(r.category, 40);
  if (category) item.category = category;
  if (r.confidence !== undefined) item.confidence = confidence(r.confidence);
  return item;
}

function techItems(raw: unknown, max = 40): DiscoveryTechItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DiscoveryTechItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = techItem(entry);
    if (!item) continue;
    // The same tool detected by two signals is one tool to a reader.
    const key = item.slug || item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function platform(raw: unknown): DiscoveryPlatform | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name) || text(r.slug);
  const s = slug(r.slug);
  // The platform card renders an icon AND a name, so unlike a tool chip it
  // genuinely needs both.
  if (!name || !s) return null;
  return { slug: s, name, confidence: confidence(r.confidence, "likely") };
}

/**
 * Always returns all four fields. `platform` may be null - that is a real
 * state, meaning "no core platform identified" - but the three collections
 * are always arrays.
 */
export function normalizeDiscoveryTechnology(raw: unknown): DiscoveryTechnology {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    platform: platform(r.platform),
    legacy: techItems(r.legacy),
    tracking: techItems(r.tracking),
    tools: techItems(r.tools),
  };
}

function channel(raw: unknown): DiscoveryChannel | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = text(r.type, 32).toLowerCase();
  if (!type) return null;
  const out: DiscoveryChannel = { type, confidence: confidence(r.confidence, "likely") };
  const identifier = text(r.identifier, 160);
  if (identifier) out.identifier = identifier;
  const purpose = text(r.purpose, 120);
  if (purpose) out.purpose = purpose;
  const provider = text(r.provider, 60);
  if (provider) out.provider = provider;
  return out;
}

/** Same guarantee for the other collection the review screen iterates. */
export function normalizeDiscoveryCommunication(raw: unknown): DiscoveryCommunication {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(r.channels)) return { channels: [] };
  const out: DiscoveryChannel[] = [];
  for (const entry of r.channels) {
    const c = channel(entry);
    if (c) out.push(c);
    if (out.length >= 40) break;
  }
  return { channels: out };
}

/**
 * Normalize a whole discovery row on its way out of the API.
 *
 * Deliberately preserves every other field untouched: this is a shape
 * guarantee for the collections that crashed, not a filter that decides
 * what the rest of the record may contain.
 */
export function normalizeDiscoveryRecord<T extends Record<string, unknown> | null | undefined>(
  record: T,
): T {
  if (!record) return record;
  return {
    ...record,
    technology: normalizeDiscoveryTechnology(record.technology),
    communication: normalizeDiscoveryCommunication(record.communication),
  } as T;
}
