import crypto from "crypto";

/**
 * Centralized, fail-closed verification for inbound provider webhooks.
 *
 * Security rule: an inbound webhook resolves the tenant from attacker-controlled
 * payload fields (recipient email, phone_number_id, subscriptionId), so a route
 * that enqueues without verifying the provider signature lets anyone forge a
 * customer message into any tenant. Every webhook route MUST call one of the
 * helpers below and drop the request when the result is not ok. Do NOT
 * re-implement signature checks per route.
 *
 * These helpers never throw; a thrown/mismatched/misconfigured state always maps
 * to ok:false so the caller fails closed.
 */

export type WebhookVerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * HMAC-style provider verification (Meta / WhatsApp / Messenger / Instagram /
 * email). `verify` is the adapter's own timing-safe comparison. A missing
 * secret, missing raw body, or missing signature all fail closed - there is no
 * "skip when the header is absent" path, which was the original bypass.
 */
export function verifyWebhookSignature(params: {
  secret: string | undefined | null;
  rawBody: Buffer | undefined | null;
  signature: string | undefined | null;
  verify: (secret: string, rawBody: Buffer, signature: string) => boolean;
}): WebhookVerifyResult {
  const { secret, rawBody, signature, verify } = params;
  if (!secret) return { ok: false, reason: "webhook secret not configured" };
  if (!rawBody) return { ok: false, reason: "raw body unavailable" };
  if (!signature) return { ok: false, reason: "missing signature header" };
  let matched = false;
  try {
    matched = verify(secret, rawBody, signature);
  } catch {
    matched = false;
  }
  return matched ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/** Constant-time string comparison that never throws on length mismatch. */
export function timingSafeEqualStr(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Shared-secret token verification for providers that do not sign the body with
 * an HMAC we can reproduce (Google Pub/Sub push, Microsoft Graph clientState).
 *
 * Policy: if the expected secret is configured, the provided value must match
 * (constant-time). If it is NOT configured, we fail closed in production and
 * allow-with-warning in non-production, so local dev without the optional
 * channel configured is not broken while prod is never left unverified.
 */
export function verifySharedSecretToken(params: {
  expected: string | undefined | null;
  provided: string | undefined | null;
  isProduction: boolean;
  label: string;
}): WebhookVerifyResult {
  const { expected, provided, isProduction, label } = params;
  if (!expected) {
    if (isProduction) return { ok: false, reason: `${label} secret not configured (required in production)` };
    console.warn(`[WEBHOOK] ${label} verification secret not set; allowing in non-production only`);
    return { ok: true };
  }
  return timingSafeEqualStr(expected, provided)
    ? { ok: true }
    : { ok: false, reason: `${label} token mismatch` };
}
