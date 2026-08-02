/**
 * Provider-neutral inbound event storage.
 *
 * This deliberately knows NOTHING about iCount's callback shape. That contract
 * is unverified, and inventing field names for it is precisely the mistake that
 * produced the fabricated `cc/charge` and `paypage/get_token_info`. What is
 * stored is a redacted body and a hash; what it MEANS is decided later, once
 * the contract is known.
 *
 * The ingestion route stays disabled until then. A disabled endpoint persists
 * nothing at all: accepting arbitrary internet payloads into the database
 * "so we have them" is a storage-exhaustion and data-handling problem, not a
 * head start.
 */
import { createHash } from "crypto";
import { prisma, redact } from "@chatcenter/shared";
import type { ProviderBillingEvent } from "@prisma/client";
import { providerEnvironment } from "./provider-customer.service";

/** Bodies larger than this are refused before being read into memory. */
export const MAX_EVENT_BODY_BYTES = 64 * 1024;

/** Feature gate. Default OFF until the callback authentication contract exists. */
export function providerEventsEnabled(): boolean {
  return String(process.env.ICOUNT_PROVIDER_EVENTS_ENABLED ?? "false").toLowerCase() === "true";
}

/**
 * Field names that must never be persisted, whatever the provider sends.
 *
 * Applied by NAME as well as by value pattern, because a provider is free to
 * put a PAN in a field we have never heard of.
 */
const FORBIDDEN_KEYS = new Set([
  "authorization", "x-internal-key", "api_token", "apitoken",
  "cc_token", "cctoken", "card_token", "cardtoken", "token",
  "pan", "card_number", "cardnumber", "cc_number", "ccnumber",
  "cvv", "cvc", "cvv2", "card_cvv", "security_code",
  "track1", "track2", "magstripe",
]);

/**
 * Strip forbidden fields, then redact what remains.
 *
 * Deletion happens BEFORE redaction so a card number cannot survive as a
 * partially-masked string that still narrows the search space.
 */
export function redactEventPayload(raw: unknown): unknown {
  const stripped = strip(raw, 0);
  return redact(stripped);
}

function strip(value: unknown, depth: number): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => strip(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) {
      out[k] = "[REMOVED]";
      continue;
    }
    out[k] = strip(v, depth + 1);
  }
  return out;
}

export function hashPayload(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

export interface RecordEventInput {
  rawBody: string;
  parsed: unknown;
  /** Only when the provider supplies one. Null until the contract is verified. */
  externalEventId?: string | null;
  verification?: "UNVERIFIED" | "VERIFIED" | "INVALID" | "UNSUPPORTED";
}

export type RecordEventResult =
  | { stored: true; event: ProviderBillingEvent; duplicate: false }
  | { stored: true; event: ProviderBillingEvent; duplicate: true }
  | { stored: false; reason: "disabled" | "too_large" };

/**
 * Persist an inbound event before any processing.
 *
 * Storage first, interpretation second: an event that crashes the processor
 * must still be reconstructable afterwards, which is the whole point of an
 * audit spine.
 */
export async function recordProviderEvent(input: RecordEventInput): Promise<RecordEventResult> {
  if (!providerEventsEnabled()) return { stored: false, reason: "disabled" };
  if (Buffer.byteLength(input.rawBody, "utf8") > MAX_EVENT_BODY_BYTES) {
    return { stored: false, reason: "too_large" };
  }

  const environment = providerEnvironment();
  const payloadHash = hashPayload(input.rawBody);
  const redactedPayload = redactEventPayload(input.parsed) as any;

  // Prefer the provider's own event id for dedup when it exists.
  if (input.externalEventId) {
    const existing = await prisma.providerBillingEvent.findUnique({
      where: {
        provider_environment_externalEventId: {
          provider: "ICOUNT",
          environment,
          externalEventId: input.externalEventId,
        },
      },
    });
    if (existing) {
      const dup = await prisma.providerBillingEvent.create({
        data: {
          provider: "ICOUNT", environment, externalEventId: null,
          payloadHash, redactedPayload,
          verification: input.verification ?? "UNVERIFIED",
          processing: "DUPLICATE",
          duplicateOfId: existing.id,
        },
      });
      return { stored: true, event: dup, duplicate: true };
    }
  }

  const event = await prisma.providerBillingEvent.create({
    data: {
      provider: "ICOUNT",
      environment,
      externalEventId: input.externalEventId ?? null,
      payloadHash,
      redactedPayload,
      verification: input.verification ?? "UNVERIFIED",
      processing: "RECEIVED",
    },
  });
  return { stored: true, event, duplicate: false };
}

/**
 * Prior events with the same body hash.
 *
 * A hash match means the BYTES repeated. It is a strong hint and a weak proof:
 * without a verified provider event id, two genuinely distinct events could
 * serialise identically, so this informs a decision rather than making one.
 */
export async function findByPayloadHash(payloadHash: string): Promise<ProviderBillingEvent[]> {
  return prisma.providerBillingEvent.findMany({
    where: { provider: "ICOUNT", environment: providerEnvironment(), payloadHash },
    orderBy: { receivedAt: "asc" },
  });
}

/**
 * An event can never activate anything on its own.
 *
 * Until the callback contract is verified there is no mapping from a payload to
 * a checkout, so every stored event is parked for a human. This is the function
 * that would grow that mapping, and it fails closed today rather than guessing.
 */
export async function processProviderEvent(eventId: string): Promise<{ processing: string }> {
  const updated = await prisma.providerBillingEvent.update({
    where: { id: eventId },
    data: {
      processing: "MANUAL_REVIEW",
      failureCode: "callback_contract_unverified",
      failureReason:
        "The provider callback contract is not verified, so this event cannot be mapped to a checkout automatically.",
      processedAt: new Date(),
    },
  });
  return { processing: updated.processing };
}
