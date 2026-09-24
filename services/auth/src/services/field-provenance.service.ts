/**
 * Which business-profile fields came from the website scan, and which a person
 * typed.
 *
 * Screen 11b's mechanic is: *"Scan again re-reads the site and only touches
 * fields marked From website; anything typed stays."* Nothing recorded that
 * distinction, so a rescan could only either overwrite a human's correction or
 * touch nothing at all.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE INFORMATION WAS NEVER CAPTURED, NOT LOST
 *
 * `BusinessProfile` is seeded at the onboarding CONFIRM step
 * (`onboarding.ts:585`), and that one upsert means two different things: "the
 * scan proposed this" and "the human accepted or corrected it". Same column,
 * same statement. It is not a bug anyone introduced - it is a distinction the
 * code never had to make until this screen existed.
 *
 * So for an existing tenant there is no provenance to recover, and this store
 * starts empty. That is why an UNTRACKED field is treated as UNKNOWN rather
 * than as scan-owned: assuming "the scan must have written it" is exactly the
 * assumption that would overwrite a correction somebody made during onboarding,
 * which is the failure the feature exists to prevent. Unknown fields are
 * OFFERED, never applied, and the map is self-healing - once a scan writes a
 * field through here, that field is marked and can be refreshed silently
 * forever after.
 *
 * ── Why this is not a column ──
 *
 * The obvious move was to copy `observedVoiceEditedAt`: one nullable timestamp
 * set by the human writer, checked by the automated one. That guards ONE field
 * with ONE automated writer. Copied to the profile it is seven columns, and a
 * migration for every scan-owned field anyone adds later.
 *
 * The codebase had already chosen a better shape for the same problem. The
 * knowledge base's re-scan uses `applyProjection(..., { removeMissing: true,
 * removeScope: ["url"] })` - *"Only crawled pages may be retired by a re-scan"*
 * - provenance scoped by source, so a sync only touches what it owns. This is
 * that rule for fields instead of documents.
 *
 * It lives in `TenantSetting` (Postgres, Redis in front) through
 * `read/writeDurableSetting`, the same store `businessHours` already uses from
 * the same route file. No schema change, and the settings store is already the
 * place admin-configured tenant state lives.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHICH STATES ARE REACHABLE - the question every comment above forgot to ask
 *
 * The first version of this had a FIXED POINT AT EMPTY, and every transition in
 * it was correct. There were two stamp sites in the platform: the rescan stamped
 * `scan` for the fields it APPLIED, and applied only fields that were ALREADY
 * scan-owned; the workspace PATCH stamped `human`. So the scan-owned set started
 * empty and nothing could add to it. Every rescan offered everything and applied
 * nothing, forever, and "after that it refreshes what it wrote itself" - written
 * confidently in this header - was vacuous.
 *
 * Accepting a proposal made it worse: with no accept path, taking a suggestion
 * meant PATCHing the value, which stamps `human` and guarantees the same field is
 * offered again next time.
 *
 * ★ SO `scan` MUST BE REACHABLE FROM OUTSIDE ITSELF, and that is what
 * `acceptScanProposal` is for. A mechanism can be fully understood and still not
 * followed to what it settles at: three readers checked the transitions and none
 * asked what the loop converges to.
 *
 * And the meaning of the stamp is what makes an accept stamp `scan` rather than
 * `human`: PROVENANCE ANSWERS ONE QUESTION - should a future scan refresh this
 * silently? - so it records what the value TRACKS, not who last clicked. A person
 * accepting the website's value has said "this field follows my site". A person
 * typing their own has said "this field is mine". Neither is a claim about who
 * pressed the button, which is why `PATCH` must keep meaning "a human set this".
 * ════════════════════════════════════════════════════════════════════════════
 */
import { readDurableSetting, writeDurableSetting } from "@chatcenter/shared";

export const PROVENANCE_KEY = "profileFieldProvenance";

export type FieldSource = "scan" | "human";

/**
 * NOT the Prisma `FieldOrigin` enum (PACK | CUSTOM | DISCOVERED), which records
 * where a custom FIELD DEFINITION came from. This records who last wrote a
 * business-profile field's VALUE. Named apart on purpose: the two would be easy
 * to conflate and mean different things about different objects.
 */
export interface FieldProvenance {
  source: FieldSource;
  /** When it was last written by that source. */
  at: string;
}

export type ProvenanceMap = Record<string, FieldProvenance>;

/**
 * The fields a scan can write AND a person can edit - the only ones where the
 * question arises. `address` and `currency` are human-only today and are
 * included because marking them costs nothing and a rescan that later learns
 * to read an address must find them already owned rather than unknown.
 */
export const PROVENANCED_FIELDS = [
  "organizationName",
  "businessDescription",
  "primaryLanguage",
  "industry",
  "country",
  "address",
  "currency",
] as const;

export type ProvenancedField = (typeof PROVENANCED_FIELDS)[number];

function isField(v: string): v is ProvenancedField {
  return (PROVENANCED_FIELDS as readonly string[]).includes(v);
}

/**
 * Read the map. Never throws and never guesses: an unreadable store yields an
 * empty map, which makes every field UNKNOWN and therefore offered rather than
 * overwritten. The safe direction when provenance cannot be read is to touch
 * nothing.
 */
export async function readProvenance(tenantId: string): Promise<ProvenanceMap> {
  try {
    const raw = await readDurableSetting(tenantId, PROVENANCE_KEY);
    if (!raw) return {};
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return {};
    const out: ProvenanceMap = {};
    for (const [field, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isField(field) || !v || typeof v !== "object") continue;
      const { source, at } = v as { source?: unknown; at?: unknown };
      if (source !== "scan" && source !== "human") continue;
      out[field] = { source, at: typeof at === "string" ? at : new Date(0).toISOString() };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Mark fields as written by `source`, MERGING into what is already stored.
 *
 * Merge rather than replace: the human writer and the scan writer each know
 * only about their own fields, and a replace from either would erase the
 * other's marks - turning owned fields back into unknown ones, which silently
 * converts a field that could be refreshed into one that can only be offered.
 */
export async function stampProvenance(
  tenantId: string,
  fields: readonly string[],
  source: FieldSource,
  actorId?: string | null,
): Promise<void> {
  const marked = fields.filter(isField);
  if (marked.length === 0) return;
  try {
    const current = await readProvenance(tenantId);
    const at = new Date().toISOString();
    for (const f of marked) current[f] = { source, at };
    await writeDurableSetting(tenantId, PROVENANCE_KEY, JSON.stringify(current), actorId ?? undefined);
  } catch (err: any) {
    // Never fail the write this decorates. A missing mark makes the field
    // unknown, so the next rescan offers it instead of applying it - degraded,
    // and degraded in the direction that cannot destroy anything.
    console.error(`[field-provenance] stamp failed for ${tenantId}:`, err?.message ?? err);
  }
}

/** What the workspace GET reports, so the screen can label each field. */
export function fieldSources(provenance: ProvenanceMap): Record<string, FieldSource | null> {
  const out: Record<string, FieldSource | null> = {};
  for (const f of PROVENANCED_FIELDS) out[f] = provenance[f]?.source ?? null;
  return out;
}

export interface RescanPlan {
  /** Safe to write silently: the scan owns these. */
  apply: Record<string, unknown>;
  /**
   * Changed on the site but NOT written, because a person owns the field or
   * nobody knows who does. The screen shows these so the merchant can take
   * them - Omer's ruling: never silently overwrite, never silently diverge.
   */
  offer: Array<{ field: string; current: unknown; proposed: unknown; because: "human_edited" | "source_unknown" }>;
}

/**
 * Decide what a rescan may write.
 *
 * Pure, so the rule is testable without a crawl, a model call or a database -
 * and so the rule is one thing in one place rather than a condition spread
 * through whichever route eventually calls it.
 *
 * A value equal to what is stored is neither applied nor offered: "the site
 * still says what it said" is not a change, and offering it would make every
 * rescan look like it found something.
 */
export function planRescan(
  provenance: ProvenanceMap,
  scanned: Record<string, unknown>,
  current: Record<string, unknown>,
): RescanPlan {
  const plan: RescanPlan = { apply: {}, offer: [] };

  for (const [field, proposed] of Object.entries(scanned)) {
    if (!isField(field)) continue;
    // A scan that found nothing for a field has not learned that the field is
    // empty. Absence is not evidence, so it never clears a stored value.
    if (proposed === null || proposed === undefined || proposed === "") continue;
    if (proposed === current[field]) continue;

    const owner = provenance[field]?.source;
    if (owner === "scan") {
      plan.apply[field] = proposed;
    } else {
      plan.offer.push({
        field,
        current: current[field] ?? null,
        proposed,
        because: owner === "human" ? "human_edited" : "source_unknown",
      });
    }
  }

  return plan;
}
