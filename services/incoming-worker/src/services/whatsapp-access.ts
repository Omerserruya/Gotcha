/**
 * A WhatsApp number our app can no longer reach (2026-11-22).
 *
 * The case: a business removed GOTCHA from its WhatsApp account at Meta. Meta
 * said so (PARTNER_REMOVED, PARTNER_APP_UNINSTALLED), every 6-hour number read
 * after that was refused, no message arrived for five days, and the channel
 * still said CONNECTED, because the token itself stayed valid and a valid
 * token was all the check looked at.
 *
 * Two ways in, one state (connectionStatus ERROR + a coded lastError):
 *  - Meta's own event, forwarded by the webhook: WHATSAPP_ACCESS_REMOVED;
 *  - the number read refused (Meta 100/33) twice in a row: WHATSAPP_NUMBER_UNREADABLE.
 * One way out besides connecting again: a number read that succeeds.
 *
 * Nobody is notified from here (Omer, 2026-11-22: the state only, for now).
 * The channels screen and the inbox read the status and the reason.
 */
import { prisma, decryptCredentials, withWhatsAppNumberDetails, type WhatsAppNumberRead } from "@chatcenter/shared";
import { withErrorCode, errorCodeOf } from "../lib/error-code";

export const ACCESS_LOST_CODES = ["WHATSAPP_ACCESS_REMOVED", "WHATSAPP_NUMBER_UNREADABLE"] as const;
/** Refused reads in a row before the number is called unreadable. */
export const REFUSED_READS_BEFORE_ERROR = 2;
/** Where the count lives: inside platformMeta, so no column is needed. */
export const REFUSED_READS_KEY = "numberReadRefusals";

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function hasAccessLostCode(stored: string | null | undefined): boolean {
  const code = errorCodeOf(stored);
  return !!code && (ACCESS_LOST_CODES as readonly string[]).includes(code);
}

export function refusedReads(platformMeta: unknown): number {
  const n = Number(asObject(platformMeta)[REFUSED_READS_KEY]);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export interface NumberReadStep {
  connectionStatus: "CONNECTED" | "ERROR";
  lastError: string | null;
  /** Present only when platformMeta has to change. */
  platformMeta?: Record<string, unknown>;
  /** True only on the read that moves the number into the state. */
  becameUnreadable: boolean;
}

/**
 * What a WhatsApp row should say after one number read, given a VALID token.
 *
 *  - a good read: CONNECTED, nothing stored against it, the count gone;
 *  - a refused read (Meta 100/33): counted. The second in a row sets the
 *    state. A row already in the state stays in it;
 *  - any other failure is no evidence either way: it counts nothing and it
 *    clears nothing, so a row in the state stays in it and every other row
 *    reads as it did before (a valid token, CONNECTED).
 */
export function afterNumberRead(
  stored: { lastError?: string | null; platformMeta?: unknown },
  read: WhatsAppNumberRead,
): NumberReadStep {
  const meta = asObject(stored.platformMeta);
  const lost = hasAccessLostCode(stored.lastError);

  if (read.ok) {
    const { [REFUSED_READS_KEY]: _count, ...rest } = meta;
    if (!read.details && !(REFUSED_READS_KEY in meta)) return { connectionStatus: "CONNECTED", lastError: null, becameUnreadable: false };
    return {
      connectionStatus: "CONNECTED",
      lastError: null,
      platformMeta: read.details ? withWhatsAppNumberDetails(rest, read.details) : rest,
      becameUnreadable: false,
    };
  }

  if (!read.refused) {
    return lost
      ? { connectionStatus: "ERROR", lastError: stored.lastError as string, becameUnreadable: false }
      : { connectionStatus: "CONNECTED", lastError: null, becameUnreadable: false };
  }

  const platformMeta = { ...meta, [REFUSED_READS_KEY]: refusedReads(meta) + 1 };
  if (lost) return { connectionStatus: "ERROR", lastError: stored.lastError as string, platformMeta, becameUnreadable: false };
  if (refusedReads(platformMeta) >= REFUSED_READS_BEFORE_ERROR) {
    return { connectionStatus: "ERROR", lastError: withErrorCode("WHATSAPP_NUMBER_UNREADABLE"), platformMeta, becameUnreadable: true };
  }
  return { connectionStatus: "CONNECTED", lastError: null, platformMeta, becameUnreadable: false };
}

/** The WABA a row belongs to, from what the row itself stores. */
function storedWabaId(account: { platformMeta?: unknown; credentials?: unknown }): string {
  const fromMeta = asObject(account.platformMeta).wabaId;
  if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta.trim();
  let creds: unknown = account.credentials;
  if (typeof creds === "string") {
    try { creds = decryptCredentials(creds); } catch { return ""; }
  }
  const fromCreds = asObject(creds).wabaId;
  return typeof fromCreds === "string" || typeof fromCreds === "number" ? String(fromCreds).trim() : "";
}

/** A row the event may move: live, and not already in the state. */
const NOT_YET_LOST = {
  OR: [
    { lastError: null },
    { AND: ACCESS_LOST_CODES.map((code) => ({ NOT: { lastError: { startsWith: `[${code}] ` } } })) },
  ],
};

/**
 * Meta's removal event for one WABA: every live channel account of that WABA
 * goes into the state. The write is conditional on the row not being in the
 * state yet, so the two events Meta sends together (uninstalled + removed)
 * change each row once, and a reason the check already stored is kept.
 */
export async function onWhatsAppAccessRemoved(input: { wabaId?: unknown; event?: unknown }): Promise<{ held: number; marked: number }> {
  const wabaId = typeof input.wabaId === "string" ? input.wabaId.trim() : "";
  const event = typeof input.event === "string" ? input.event : "account_update";
  if (!wabaId) return { held: 0, marked: 0 };

  const live = { channel: "WHATSAPP" as const, isActive: true, connectionStatus: { in: ["CONNECTED" as const, "ERROR" as const] } };
  const accounts = await prisma.channelAccount.findMany({
    where: live,
    select: { id: true, credentials: true, platformMeta: true },
  });
  let numbered = new Set<string>();
  try {
    const rows = await prisma.whatsAppNumber.findMany({ where: { wabaId }, select: { channelAccountId: true } });
    numbered = new Set(rows.map((r) => r.channelAccountId));
  } catch (err: any) {
    console.warn("[whatsapp-access] could not read whatsapp_numbers, matching on the stored WABA id only:", err?.message);
  }
  const held = accounts.filter((a) => numbered.has(a.id) || storedWabaId(a) === wabaId);
  if (held.length === 0) {
    console.warn(`[whatsapp-access] ${event} for WABA ${wabaId}: no live channel account of ours, nothing changed`);
    return { held: 0, marked: 0 };
  }

  let marked = 0;
  for (const a of held) {
    const res = await prisma.channelAccount.updateMany({
      where: { id: a.id, ...live, ...NOT_YET_LOST },
      data: { connectionStatus: "ERROR", lastError: withErrorCode("WHATSAPP_ACCESS_REMOVED") },
    });
    marked += res.count;
  }
  console.warn(`[whatsapp-access] ${event} for WABA ${wabaId}: ${marked} of ${held.length} channel account(s) set to ERROR (WHATSAPP_ACCESS_REMOVED)`);
  return { held: held.length, marked };
}
