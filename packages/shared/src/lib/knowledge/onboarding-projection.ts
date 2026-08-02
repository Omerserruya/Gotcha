/**
 * Onboarding → Knowledge Base projection.
 *
 * Everything the platform learns about a tenant during onboarding used to end
 * its life inside `BusinessDiscovery`'s JSON columns and the readiness report:
 * readable on the "Your Business" page, invisible to the AI employee, because
 * retrieval only ever searches `KnowledgeDocument` chunks. A customer who
 * answered eight questions during setup then watched the employee say "I don't
 * have that information" was not wrong to lose trust - the answers genuinely
 * were not in the knowledge base.
 *
 * This module is the one place that turns the collected material into KB
 * entries. It is deliberately pure: given a discovery record it returns the
 * documents that SHOULD exist, and given the documents that DO exist it
 * returns a plan (create / update / unchanged / remove). The callers - the
 * onboarding route, the website re-scan, the backfill - all share it, so a
 * re-scan and a first scan cannot drift apart.
 *
 * Two rules drive the whole design:
 *
 *   1. Deduplication is deterministic, never heuristic. Every projected entry
 *      carries a `dedupeKey` derived from (sourceType, normalized URL | topic).
 *      Re-running a scan matches on that key, so the third scan of a site
 *      produces the same document count as the first. A checksum over the
 *      normalized content then decides update-vs-unchanged, so an unchanged
 *      page costs no embedding work.
 *
 *   2. A human edit outranks a machine refresh. Once someone corrects a
 *      generated entry we mark it `manualEdit` and a later re-scan reports it
 *      as `preserved` instead of overwriting the correction. Silently
 *      reverting a customer's fix is the fastest way to make them stop fixing
 *      things.
 */

import { createHash } from "crypto";

// ─── Topics ─────────────────────────────────────────────────
// Topic-based entries, not one unreadable mega-document. These are stable
// identifiers: they form part of the dedupe key for non-URL entries, so
// renaming one would orphan every existing document that used it.

export const KB_TOPICS = [
  "business_overview",
  "products_services",
  "support_info",
  "shipping_returns",
  "pricing_policies",
  "contact_hours",
  "faq",
  "brand_voice",
  "processes",
  "website_pages",
  "readiness_answers",
] as const;

export type KbTopic = (typeof KB_TOPICS)[number];

/** Source families. `sourceType` is also persisted on KnowledgeDocument. */
export type KbSourceType =
  | "onboarding_scan" // synthesized from the website scan
  | "onboarding_answer" // the customer typed it
  | "readiness_answer" // answered a readiness-report gap
  | "url" // an individual crawled page
  | "file" // an uploaded document
  | "drive"; // a connected Google Drive file

export interface KbSourceMetadata {
  /** Marks the document as machine-generated from onboarding material. */
  origin: "onboarding";
  topic: KbTopic;
  sourceType: KbSourceType;
  /** Stable identity for re-scan matching. See `dedupeKeyFor`. */
  dedupeKey: string;
  sourceUrl?: string;
  normalizedUrl?: string;
  /** sha256 over the normalized content - decides update vs unchanged. */
  checksum: string;
  /** Bumped whenever the projection logic changes shape materially. */
  scanVersion: number;
  language: string;
  createdDuringOnboarding: boolean;
  lastRefreshedAt: string;
  /** Set once a human edits the generated body; blocks machine overwrite. */
  manualEdit?: boolean;
}

export interface ProjectedEntry {
  topic: KbTopic;
  title: string;
  content: string;
  sourceType: KbSourceType;
  sourceUrl?: string;
  metadata: KbSourceMetadata;
}

/**
 * Current projection version. Bump when the generated BODY of an entry
 * changes shape enough that existing documents should be refreshed even
 * though their inputs did not change.
 */
export const SCAN_VERSION = 1;

// ─── URL normalization ──────────────────────────────────────

/**
 * Normalize a URL for identity purposes.
 *
 * `https://Shop.example.com/products/?utm_source=x#top` and
 * `http://shop.example.com/products` are the same page for our purposes, and
 * treating them as different is exactly how a re-scan doubles the document
 * count. Tracking parameters are stripped because they change per visit;
 * ordinary query parameters are kept and sorted because `?id=12` really is a
 * different page.
 */
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "_ga", "ref", "referrer",
]);

export function normalizeUrl(raw: string): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let candidate = raw.trim();
  // Check for an EXISTING scheme before defaulting to https. Prepending
  // blindly turned "file:///etc/passwd" into "https://file:///etc/passwd",
  // which parses cleanly with host "file" - a rejected input laundered into a
  // valid-looking dedupe key.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(candidate);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s !== "http" && s !== "https") return null;
  } else {
    candidate = `https://${candidate}`;
  }
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  // Trailing slash is not a distinct page; an empty path is the root.
  let path = u.pathname.replace(/\/+$/, "");
  if (!path) path = "/";

  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length
    ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&")
    : "";

  // Scheme and fragment are deliberately dropped: http/https of the same page
  // is the same content, and a fragment never changes what the server sends.
  return `${host}${path}${query}`;
}

// ─── Content normalization + checksum ───────────────────────

/**
 * Collapse the incidental differences that a re-crawl produces - whitespace
 * runs, CRLF, a trailing newline - so an untouched page checksums identically
 * on every scan. Without this, "updated" fires on every single refresh and
 * the whole update-vs-unchanged distinction is noise.
 */
export function normalizeContent(raw: string): string {
  return String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export function checksumOf(content: string): string {
  return createHash("sha256").update(normalizeContent(content), "utf8").digest("hex");
}

/**
 * Deterministic identity for a projected entry.
 *
 * URL-backed entries key on the normalized URL, so the same page found via a
 * different casing or with a tracking parameter maps to one document. Topic
 * entries key on the topic, so "Business overview" is refreshed rather than
 * re-created. Files and Drive items key on their own stable identifier.
 */
export function dedupeKeyFor(input: {
  sourceType: KbSourceType;
  topic: KbTopic;
  sourceUrl?: string;
  externalId?: string;
}): string {
  const { sourceType, topic, sourceUrl, externalId } = input;
  if (sourceType === "url") {
    const n = sourceUrl ? normalizeUrl(sourceUrl) : null;
    // A URL entry with an unusable URL would otherwise collide with every
    // other such entry under one key and silently overwrite them.
    return `url:${n ?? `invalid:${checksumOf(sourceUrl ?? topic).slice(0, 16)}`}`;
  }
  if (sourceType === "file" || sourceType === "drive") {
    return `${sourceType}:${externalId ?? checksumOf(topic).slice(0, 16)}`;
  }
  return `${sourceType}:${topic}`;
}

// ─── Reconciliation ─────────────────────────────────────────

export type ReconcileAction = "create" | "update" | "unchanged" | "preserved" | "remove";

export interface ExistingDoc {
  id: string;
  title: string;
  metadata: unknown;
  status?: string;
}

export interface ReconcileItem {
  action: ReconcileAction;
  dedupeKey: string;
  /** Present for create/update/unchanged/preserved. */
  entry?: ProjectedEntry;
  /** Present for update/unchanged/preserved/remove. */
  existingId?: string;
  reason?: string;
}

export interface ReconcilePlan {
  items: ReconcileItem[];
  summary: {
    added: number;
    updated: number;
    unchanged: number;
    preserved: number;
    removed: number;
  };
}

function readMeta(raw: unknown): Partial<KbSourceMetadata> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Partial<KbSourceMetadata>;
}

/**
 * Compare what the scan produced against what the tenant already has.
 *
 * `removeMissing` is off by default and only the website re-scan turns it on,
 * scoped to `url` entries: a topic summary that this scan happened not to
 * produce (because the LLM step failed, say) must not delete the good summary
 * from last week, whereas a page that genuinely 404s now should be reported as
 * gone. Documents with no onboarding metadata are invisible to this function
 * entirely - manually added knowledge is never touched by a scan.
 */
export function reconcile(
  projected: ProjectedEntry[],
  existing: ExistingDoc[],
  options: { removeMissing?: boolean; removeScope?: KbSourceType[] } = {},
): ReconcilePlan {
  const items: ReconcileItem[] = [];

  const owned = new Map<string, ExistingDoc>();
  for (const doc of existing) {
    const meta = readMeta(doc.metadata);
    if (!meta || meta.origin !== "onboarding" || !meta.dedupeKey) continue;
    // First writer wins: if a historical bug produced two documents under one
    // key, we refresh the first and report the rest as removable duplicates
    // rather than updating an arbitrary one of them.
    if (owned.has(meta.dedupeKey)) {
      items.push({
        action: "remove",
        dedupeKey: meta.dedupeKey,
        existingId: doc.id,
        reason: "duplicate",
      });
      continue;
    }
    owned.set(meta.dedupeKey, doc);
  }

  const seen = new Set<string>();
  for (const entry of projected) {
    const key = entry.metadata.dedupeKey;
    seen.add(key);
    const prior = owned.get(key);
    if (!prior) {
      items.push({ action: "create", dedupeKey: key, entry });
      continue;
    }
    const priorMeta = readMeta(prior.metadata)!;
    if (priorMeta.manualEdit === true) {
      items.push({
        action: "preserved",
        dedupeKey: key,
        entry,
        existingId: prior.id,
        reason: "manual_edit",
      });
      continue;
    }
    const sameContent = priorMeta.checksum === entry.metadata.checksum;
    const sameVersion = priorMeta.scanVersion === entry.metadata.scanVersion;
    if (sameContent && sameVersion) {
      items.push({ action: "unchanged", dedupeKey: key, entry, existingId: prior.id });
      continue;
    }
    items.push({
      action: "update",
      dedupeKey: key,
      entry,
      existingId: prior.id,
      reason: sameContent ? "scan_version" : "content_changed",
    });
  }

  if (options.removeMissing) {
    const scope = options.removeScope;
    for (const [key, doc] of owned) {
      if (seen.has(key)) continue;
      const meta = readMeta(doc.metadata)!;
      if (scope && !scope.includes(meta.sourceType as KbSourceType)) continue;
      items.push({ action: "remove", dedupeKey: key, existingId: doc.id, reason: "no_longer_found" });
    }
  }

  const summary = { added: 0, updated: 0, unchanged: 0, preserved: 0, removed: 0 };
  for (const item of items) {
    if (item.action === "create") summary.added += 1;
    else if (item.action === "update") summary.updated += 1;
    else if (item.action === "unchanged") summary.unchanged += 1;
    else if (item.action === "preserved") summary.preserved += 1;
    else if (item.action === "remove") summary.removed += 1;
  }

  return { items, summary };
}

// ─── Entry construction ─────────────────────────────────────

export function buildEntry(input: {
  topic: KbTopic;
  title: string;
  content: string;
  sourceType: KbSourceType;
  sourceUrl?: string;
  externalId?: string;
  language: string;
  now: string;
  createdDuringOnboarding?: boolean;
}): ProjectedEntry {
  const content = normalizeContent(input.content);
  const normalizedUrl = input.sourceUrl ? normalizeUrl(input.sourceUrl) ?? undefined : undefined;
  const dedupeKey = dedupeKeyFor({
    sourceType: input.sourceType,
    topic: input.topic,
    sourceUrl: input.sourceUrl,
    externalId: input.externalId,
  });
  return {
    topic: input.topic,
    title: input.title,
    content,
    sourceType: input.sourceType,
    sourceUrl: input.sourceUrl,
    metadata: {
      origin: "onboarding",
      topic: input.topic,
      sourceType: input.sourceType,
      dedupeKey,
      sourceUrl: input.sourceUrl,
      normalizedUrl,
      checksum: checksumOf(content),
      scanVersion: SCAN_VERSION,
      language: input.language,
      createdDuringOnboarding: input.createdDuringOnboarding ?? true,
      lastRefreshedAt: input.now,
    },
  };
}
