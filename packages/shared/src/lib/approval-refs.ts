/**
 * One-tap approval references for out-of-band (WhatsApp) decisions.
 *
 * WHY AN OPAQUE REFERENCE, NOT A SIGNED TOKEN
 * A WhatsApp reply button carries an `id` that comes straight back to us on
 * tap, and it is visible in the recipient's client, in Meta's logs, and in any
 * message backup. So the button must carry NO payload: not the tenant, not the
 * tool, not the customer, not a JWT that can be decoded. It carries a random
 * 24-byte handle and nothing else. Every fact about the decision lives
 * server-side in Redis, keyed by that handle.
 * (It also sidesteps WhatsApp's 256-char button-id limit, which a JWT with
 * real claims would flirt with.)
 *
 * BINDINGS (all checked at consume time, none trusted from the message):
 *   tenant · approval request · intended recipient · the exact decision the
 *   button represents · the tool being authorised · expiry.
 *
 * SINGLE USE: consuming DELETES the handle atomically, so a forwarded or
 * replayed button tap finds nothing. Both handles of a pair (approve/reject)
 * are revoked together the moment either is used - otherwise a manager who
 * taps "Approve" could still tap "Reject" a second later and the second tap
 * would look legitimate.
 */

import crypto from "crypto";
import { getRedis } from "./redis";

/** Buttons are short-lived: a decision made hours later belongs in the UI. */
const DEFAULT_TTL_SECONDS = 30 * 60;

const REF_PREFIX = "apv_";
const refKey = (ref: string) => `approval:ref:${ref}`;
/** Set of handles minted for one approval, so all can be revoked at once. */
const pairKey = (approvalId: string) => `approval:refset:${approvalId}`;

export type ApprovalDecision = "approve" | "reject";

export interface ApprovalRefBinding {
  tenantId: string;
  approvalId: string;
  /** The membership this button was sent to. Re-authorised at consume time. */
  recipientUserId: string;
  decision: ApprovalDecision;
  /** The tool being authorised - checked against the row so a handle minted
   *  for one action can never decide a different one. */
  tool: string;
  channel: "whatsapp";
}

export function isApprovalRef(value: string | undefined | null): boolean {
  return !!value && value.startsWith(REF_PREFIX);
}

/**
 * Mint one handle per decision for an approval. Returns them together so the
 * caller can render exactly two buttons.
 */
export async function mintApprovalRefs(
  binding: Omit<ApprovalRefBinding, "decision">,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<Record<ApprovalDecision, string>> {
  const redis = getRedis();
  const out = {} as Record<ApprovalDecision, string>;
  const decisions: ApprovalDecision[] = ["approve", "reject"];

  for (const decision of decisions) {
    const ref = REF_PREFIX + crypto.randomBytes(24).toString("hex");
    await redis.set(refKey(ref), JSON.stringify({ ...binding, decision }), "EX", ttlSeconds);
    await redis.sadd(pairKey(binding.approvalId), ref);
    out[decision] = ref;
  }
  // The set must not outlive its members.
  await redis.expire(pairKey(binding.approvalId), ttlSeconds);
  return out;
}

/**
 * Consume a handle: read the binding and destroy BOTH handles for that
 * approval, so the opposite button cannot be tapped afterwards.
 *
 * Returns null for unknown/expired/already-used handles - the caller must
 * treat all three identically to the sender.
 */
export async function consumeApprovalRef(ref: string): Promise<ApprovalRefBinding | null> {
  if (!isApprovalRef(ref)) return null;
  const redis = getRedis();

  // GETDEL makes read-and-burn atomic: two simultaneous taps cannot both win.
  let raw: string | null;
  try {
    raw = await (redis as any).getdel(refKey(ref));
  } catch {
    // Older Redis without GETDEL: fall back to GET + DEL and rely on the DEL
    // result to decide the winner.
    raw = await redis.get(refKey(ref));
    if (raw) {
      const removed = await redis.del(refKey(ref));
      if (removed === 0) return null; // someone else burned it first
    }
  }
  if (!raw) return null;

  let binding: ApprovalRefBinding;
  try {
    binding = JSON.parse(raw) as ApprovalRefBinding;
  } catch {
    return null;
  }

  // Revoke the sibling handle(s) - one decision per approval, ever.
  try {
    const siblings = await redis.smembers(pairKey(binding.approvalId));
    const others = siblings.filter((r) => r !== ref);
    if (others.length) await redis.del(...others.map(refKey));
    await redis.del(pairKey(binding.approvalId));
  } catch {
    /* best effort - the row-level CAS is the real guard */
  }

  return binding;
}

/** Revoke every handle for an approval (decided in the UI, expired, cancelled). */
export async function revokeApprovalRefs(approvalId: string): Promise<void> {
  try {
    const redis = getRedis();
    const refs = await redis.smembers(pairKey(approvalId));
    if (refs.length) await redis.del(...refs.map(refKey));
    await redis.del(pairKey(approvalId));
  } catch {
    /* best effort */
  }
}

// ─── Phone normalisation ────────────────────────────────────

/**
 * Normalise to E.164, or null when it cannot be trusted.
 *
 * Deliberately strict: a wrong number here means an approval request for one
 * business is delivered to a stranger. We accept an explicit `+` form, or a
 * national number when a default country calling code is supplied.
 */
export function normalizeE164(input: string, defaultCountryCode?: string): string | null {
  if (!input) return null;
  const trimmed = input.trim().replace(/[\s()\-.]/g, "");

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1);
    if (!/^\d{8,15}$/.test(digits)) return null;
    return `+${digits}`;
  }
  // Local form (e.g. Israeli "0501234567") needs a country code to be safe.
  if (defaultCountryCode && /^\d{6,15}$/.test(trimmed)) {
    const cc = defaultCountryCode.replace(/^\+/, "");
    if (!/^\d{1,4}$/.test(cc)) return null;
    const national = trimmed.replace(/^0+/, "");
    const full = `${cc}${national}`;
    if (!/^\d{8,15}$/.test(full)) return null;
    return `+${full}`;
  }
  return null;
}
