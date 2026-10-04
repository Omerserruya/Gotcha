'use server';

/**
 * Connecting a WhatsApp number — the three server actions behind 13c/13d.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ TWO OF THESE MUTATE A REAL MESSAGING ACCOUNT. NOTHING AUTOMATED MAY FIRE
 *   THEM — NOT A TEST, NOT A CAPTURE, NOT ONCE TO SEE.
 * ════════════════════════════════════════════════════════════════════════════
 *   inspect   reads Meta · SPENDS a single-use authorization code ·
 *             REPLACES the tenant's signup session
 *   connect   subscribeApp(wabaId) + client.register(...) — writes at Meta,
 *             creates a WhatsAppNumber and a ChannelAccount
 *   resume    the register step with the customer's PIN — writes at Meta
 *
 * Dev points at a real Meta business account and sends real traffic. Component
 * tests mock this module; the live path is exercised by a person, on purpose,
 * with Omer's say-so.
 *
 * ── THE TOKEN NEVER PASSES THROUGH HERE ──
 * `inspect` exchanges the code server-side and keeps the customer's access
 * token in Redis, tenant-scoped, under an opaque `sessionId`. The browser
 * holds the id and nothing else, and `connect` takes the id rather than a
 * credential. Passing the token through the client is the obvious shape and
 * is exactly what the platform built this session store to prevent.
 */

import { z } from 'zod';

import { inspectResponseSchema, type InspectResponse } from '@/api/contracts/whatsapp-connect';
import { channelEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * Neither verb returns anything the screen renders — the list is re-read
 * afterwards. Parsed anyway rather than left untyped, so a response shape
 * that changes is a parse failure here and not a silent success.
 */
const ackSchema = z.object({}).loose();

export type ConnectResult = { ok: true } | { ok: false; message: string };

/** Read the numbers on the account the customer just authorised. */
export async function inspectNumbers(
  code: string,
  /** What the popup told us (business portfolio, WABA ids) — the server uses them. */
  assets: { readonly businessPortfolioId?: string; readonly wabaIds?: readonly string[] } = {},
): Promise<InspectResponse | null> {
  try {
    return await serverApi().post({
      endpoint: channelEndpoints.whatsappInspect(),
      body: {
        code,
        ...(assets.businessPortfolioId ? { businessPortfolioId: assets.businessPortfolioId } : {}),
        ...(assets.wabaIds?.length ? { wabaIds: [...assets.wabaIds] } : {}),
      },
      payload: inspectResponseSchema,
      raw: true,
    });
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('whatsapp.inspect_failed', { cause });
    return null;
  }
}

/** Connect ONE number. Writes at Meta. */
export async function connectNumber(
  sessionId: string,
  phoneNumberId: string,
): Promise<ConnectResult> {
  try {
    await serverApi().post({
      endpoint: channelEndpoints.whatsappConnect(),
      body: { sessionId, phoneNumberId },
      payload: ackSchema,
      raw: true,
    });
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('whatsapp.connect_failed', { cause });
    return { ok: false, message: (cause as Error)?.message ?? 'connect_failed' };
  }
}

/** Supply what the customer was asked for — the PIN. Writes at Meta. */
export async function resumeNumber(id: string, pin: string): Promise<ConnectResult> {
  try {
    await serverApi().post({
      endpoint: channelEndpoints.whatsappResume(id),
      body: { pin },
      payload: ackSchema,
      raw: true,
    });
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('whatsapp.resume_failed', { cause });
    return { ok: false, message: (cause as Error)?.message ?? 'resume_failed' };
  }
}
