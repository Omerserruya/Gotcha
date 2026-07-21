/**
 * Cross-identity verification: OTP to the STORED trusted destination only.
 *
 * The requester must prove control of a destination the business ALREADY has
 * on file for the target customer. A destination supplied in the same chat is
 * untrusted by definition and can never receive the code - that would let an
 * attacker "verify" against their own inbox (the exact prohibited pattern
 * from the 2026-07-20 incident review).
 *
 * Lifecycle: issue (code hashed, 10-minute expiry, previous pending codes for
 * the conversation invalidated) → deliver to the stored phone via the normal
 * outbound queue → confirm (attempt-limited; success converts the row into a
 * short-lived ACCESS GRANT consumed by customer-access-guard). Codes and
 * grants are tenant-, conversation- and target-customer-scoped: customer A's
 * grant can never authorize customer B, and another conversation's grant
 * never applies here.
 */
import { createHash, randomInt } from "node:crypto";
import { prisma } from "./prisma";
import { outgoingMessageQueue } from "./queue";

const CODE_TTL_MS = 10 * 60 * 1000;   // code must be used within 10 minutes
const GRANT_TTL_MS = 15 * 60 * 1000;  // verified access window
const MAX_ATTEMPTS = 5;

function hashCode(tenantId: string, code: string): string {
  return createHash("sha256").update(`${tenantId}:${code}`).digest("hex");
}

function maskPhone(v: string | null | undefined): string {
  const digits = String(v ?? "").replace(/\D/g, "");
  return `***${digits.slice(-4)}`;
}

export interface IssueVerificationInput {
  tenantId: string;
  conversationId: string;
  /** Target customer's identifiers AS STORED in the Source of Truth. */
  target: { customerId?: string | null; phone?: string | null; email?: string | null };
}

export interface IssueVerificationResult {
  ok: boolean;
  /** Masked destination safe to echo to the requester ("***0665"). */
  sentToMasked?: string;
  reason?: string;
}

/**
 * Issue a verification code and queue its delivery to the target's STORED
 * phone over the conversation's channel. Never accepts a destination from the
 * caller beyond the stored identifiers themselves.
 */
export async function issueCustomerVerification(
  input: IssueVerificationInput,
): Promise<IssueVerificationResult> {
  const storedPhone = String(input.target.phone ?? "").replace(/\D/g, "");
  if (!storedPhone || storedPhone.length < 7) {
    return { ok: false, reason: "no_stored_phone_for_target" };
  }
  const conv = await (prisma as any).conversation.findFirst({
    where: { id: input.conversationId, tenantId: input.tenantId },
    select: { id: true, channel: true, channelAccountId: true, customerExternalId: true },
  });
  if (!conv?.channelAccountId) return { ok: false, reason: "conversation_channel_unavailable" };

  // One live code per conversation: kill previous pending codes so a guessed
  // old code can't race a new one.
  await (prisma as any).customerVerification.updateMany({
    where: {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      verifiedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { expiresAt: new Date() },
  });

  const code = String(randomInt(100000, 1000000)); // 6 digits, crypto RNG
  await (prisma as any).customerVerification.create({
    data: {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      channelSenderId: conv.customerExternalId ?? null,
      targetCustomerId: input.target.customerId ? String(input.target.customerId) : null,
      targetPhone: storedPhone,
      targetEmail: input.target.email ? String(input.target.email).toLowerCase() : null,
      method: "otp_whatsapp_stored_phone",
      codeHash: hashCode(input.tenantId, code),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
      maxAttempts: MAX_ATTEMPTS,
    },
  });

  // Audit-visible record in the conversation WITHOUT the code.
  const msg = await (prisma as any).message.create({
    data: {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      channel: conv.channel,
      direction: "OUTBOUND",
      body: `[verification code sent to ${maskPhone(storedPhone)}]`,
      messageType: "system",
      senderName: "System",
      status: "PENDING",
      metadata: { verification: true, destinationMasked: maskPhone(storedPhone) },
    },
  });
  // The CODE goes only to the STORED phone. NOTE: WhatsApp only delivers
  // freeform text inside an open 24h session; production tenants need an
  // approved OTP template for cold sends - documented limitation, the queue
  // will surface a delivery failure honestly if outside the window.
  await outgoingMessageQueue.add(
    "send",
    {
      tenantId: input.tenantId,
      conversationId: conv.id,
      channel: conv.channel,
      channelAccountId: conv.channelAccountId,
      recipientExternalId: storedPhone,
      body: `Urban verification code: ${code}. Valid for 10 minutes. If you did not request this, ignore this message.`,
      messageType: "text",
      senderName: "System",
      messageId: msg.id,
    },
    { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
  );
  return { ok: true, sentToMasked: maskPhone(storedPhone) };
}

export interface ConfirmVerificationResult {
  ok: boolean;
  verified?: boolean;
  remainingAttempts?: number;
  reason?: string;
}

/** Confirm a code typed in THIS conversation. Attempt-limited, single-use. */
export async function confirmCustomerVerification(opts: {
  tenantId: string;
  conversationId: string;
  code: string;
}): Promise<ConfirmVerificationResult> {
  const row = await (prisma as any).customerVerification.findFirst({
    where: {
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      verifiedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return { ok: false, reason: "no_active_verification" };
  if (row.attempts >= row.maxAttempts) {
    return { ok: false, reason: "too_many_attempts" };
  }

  const match = row.codeHash === hashCode(opts.tenantId, String(opts.code).trim());
  if (!match) {
    const updated = await (prisma as any).customerVerification.update({
      where: { id: row.id },
      data: {
        attempts: { increment: 1 },
        // burn the code once attempts run out
        ...(row.attempts + 1 >= row.maxAttempts ? { expiresAt: new Date() } : {}),
      },
    });
    return { ok: false, verified: false, remainingAttempts: Math.max(0, row.maxAttempts - updated.attempts) };
  }

  // Success: the row becomes a short-lived ACCESS GRANT (expiresAt reused as
  // the grant window; the guard requires verifiedAt + unexpired).
  await (prisma as any).customerVerification.update({
    where: { id: row.id },
    data: { verifiedAt: new Date(), expiresAt: new Date(Date.now() + GRANT_TTL_MS) },
  });
  return { ok: true, verified: true };
}
