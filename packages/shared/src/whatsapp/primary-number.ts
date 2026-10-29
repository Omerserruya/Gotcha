/**
 * The tenant's primary WhatsApp number (2026-10-29).
 *
 * A tenant may connect several numbers, on one WABA or on separate ones. Most
 * sends belong to a conversation and go out on that conversation's own number.
 * A few do not: an unbound template's Meta calls, a manager's approval
 * request, a new abandoned-cart conversation, a voice-flow or missed-call
 * template with no binding. Those used to take `findFirst` with no order -
 * whichever row Postgres returned - so with two WABAs a template could be
 * created on the wrong business account.
 *
 * They now ask for the primary: the number the tenant chose, while it is still
 * active, else the first active one by connectedAt (CONNECTED preferred). The
 * choice is a durable tenant setting, not a column, so no migration.
 *
 * A stored id is never trusted on its own: every read re-checks it against
 * the caller's own filters, so a disconnected primary falls through to the
 * default instead of sending from a dead number.
 */

import { prisma } from "../lib/prisma";
import { readDurableSetting, writeDurableSetting } from "../lib/durable-settings";

export const WHATSAPP_PRIMARY_SETTING = "whatsappPrimaryChannelAccountId";

export type PrimarySource = "chosen" | "default" | "none";

/** The id the tenant chose, or null. Never validated here; callers re-check it. */
export async function chosenPrimaryWhatsAppId(tenantId: string): Promise<string | null> {
  const raw = await readDurableSetting(tenantId, WHATSAPP_PRIMARY_SETTING).catch(() => null);
  if (!raw) return null;
  let v: unknown = raw;
  try { v = JSON.parse(raw); } catch { /* stored as a bare string */ }
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The Prisma client to read through. Callers pass their own `prisma` (the one
 * they import from @chatcenter/shared), so the helper reads exactly what the
 * code around it reads, and a test double of that client covers it too.
 */
type Db = { channelAccount: { findFirst: (args: any) => Promise<any> } };

const DEFAULT_ORDER = [{ connectedAt: "asc" as const }, { createdAt: "asc" as const }, { id: "asc" as const }];

/**
 * The tenant's primary WhatsApp account, within the caller's own filters
 * (`where` is merged over tenant + WHATSAPP + isActive). Returns the row with
 * `select` applied, plus where the answer came from.
 */
export async function resolvePrimaryWhatsAppAccount<S extends Record<string, unknown> | undefined = undefined>(
  tenantId: string,
  opts: { where?: Record<string, unknown>; select?: S; db?: Db } = {},
): Promise<{ account: any | null; source: PrimarySource }> {
  const db: Db = opts.db ?? (prisma as any);
  const base = { tenantId, channel: "WHATSAPP" as any, isActive: true, ...(opts.where || {}) };
  const select = opts.select as any;

  const chosen = await chosenPrimaryWhatsAppId(tenantId);
  if (chosen) {
    const account = await db.channelAccount.findFirst({ where: { ...base, id: chosen }, ...(select ? { select } : {}) });
    if (account) return { account, source: "chosen" };
  }

  const connected = await db.channelAccount.findFirst({
    where: { connectionStatus: "CONNECTED" as any, ...base },
    orderBy: DEFAULT_ORDER,
    ...(select ? { select } : {}),
  });
  if (connected) return { account: connected, source: "default" };

  const any = await db.channelAccount.findFirst({ where: base, orderBy: DEFAULT_ORDER, ...(select ? { select } : {}) });
  return any ? { account: any, source: "default" } : { account: null, source: "none" };
}

/** Just the effective primary's id and source, for the numbers screen. */
export async function primaryWhatsAppState(tenantId: string, db?: Db): Promise<{ channelAccountId: string | null; source: PrimarySource }> {
  const { account, source } = await resolvePrimaryWhatsAppAccount(tenantId, { select: { id: true }, db });
  return { channelAccountId: account?.id ?? null, source };
}

export class PrimaryNumberError extends Error {
  constructor(public code: "WHATSAPP_NUMBER_NOT_FOUND" | "WHATSAPP_NUMBER_NOT_ACTIVE", public status: number) {
    super(code);
  }
}

/**
 * Choose the primary (an id) or clear the choice (null, back to the default).
 * The id must be this tenant's WhatsApp account and active.
 */
export async function setPrimaryWhatsAppAccount(
  tenantId: string,
  channelAccountId: string | null,
  updatedBy?: string,
  db?: Db,
): Promise<{ channelAccountId: string | null; source: PrimarySource }> {
  if (channelAccountId !== null) {
    const row = await (db ?? (prisma as any)).channelAccount.findFirst({
      where: { id: channelAccountId, tenantId, channel: "WHATSAPP" as any },
      select: { id: true, isActive: true, connectionStatus: true },
    });
    if (!row) throw new PrimaryNumberError("WHATSAPP_NUMBER_NOT_FOUND", 404);
    if (!row.isActive || row.connectionStatus === ("DISCONNECTED" as any)) {
      throw new PrimaryNumberError("WHATSAPP_NUMBER_NOT_ACTIVE", 409);
    }
  }
  await writeDurableSetting(tenantId, WHATSAPP_PRIMARY_SETTING, channelAccountId === null ? null : JSON.stringify(channelAccountId), updatedBy);
  return primaryWhatsAppState(tenantId, db);
}

/** A number left the tenant: drop the choice if it was this one, and say who is primary now. */
export async function releasePrimaryIfRemoved(
  tenantId: string,
  channelAccountId: string,
  db?: Db,
): Promise<{ channelAccountId: string | null; source: PrimarySource }> {
  if ((await chosenPrimaryWhatsAppId(tenantId)) === channelAccountId) {
    await writeDurableSetting(tenantId, WHATSAPP_PRIMARY_SETTING, null);
  }
  return primaryWhatsAppState(tenantId, db);
}
