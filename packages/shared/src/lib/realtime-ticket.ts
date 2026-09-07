/**
 * Short-lived, single-use tickets for authenticating a WebSocket handshake.
 *
 * A browser cannot set headers on a WebSocket upgrade. Every workaround puts a
 * credential somewhere it does not belong, so the question is only which
 * credential you are willing to put there. Today both sockets take the
 * Authentik ACCESS TOKEN - the notifications server reads it out of `?token=`,
 * where it lands in the gateway's access log, any intermediary's log, and the
 * browser's own history, and stays valid for its full lifetime wherever it was
 * copied to.
 *
 * A ticket is the opposite trade: minted by an already-authenticated HTTP
 * request, valid for 60 seconds, and destroyed by the first redemption. Leaking
 * a spent ticket discloses nothing, because there is nothing left to spend.
 *
 * The ticket is not a token. It carries no claims a client can read and is not
 * verified by signature - it is an opaque key into a server-side record, so the
 * principal a socket ends up with is the one the HTTP request proved, not one a
 * client asserted. See docs/security/bff-session-migration-map.md §A9.
 */
import crypto from "crypto";
import { getRedis } from "./redis";
import type { JwtPayload } from "./jwt";

/**
 * Long enough that a connection survives a slow page load and a retry, short
 * enough that a ticket which escapes is almost certainly already dead. §A9 says
 * "~30s"; 60 is the same order and leaves room for a cold socket on mobile.
 */
export const REALTIME_TICKET_TTL_SECONDS = 60;

const TICKET_BYTES = 32; // 256 bits, same floor as the session token
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
const KEY_PREFIX = "realtime:ticket:";

/** What a redeemed ticket resolves to: the principal that minted it. */
export interface RealtimeTicketPrincipal {
  userId: string;
  identityId?: string;
  tenantId: string;
  role: string;
  email: string;
  departmentId?: string;
  departmentRole?: string;
}

export function isWellFormedRealtimeTicket(value: unknown): value is string {
  return typeof value === "string" && TICKET_RE.test(value);
}

/**
 * Key the ticket by its HASH, so a Redis dump - a backup, a `KEYS *`, a shared
 * dev instance - never yields a usable credential. Same reasoning as
 * UserSession.sessionTokenHash.
 */
function ticketKey(ticket: string): string {
  const hash = crypto.createHash("sha256").update("gotcha.realtime.v1:").update(ticket).digest("hex");
  return `${KEY_PREFIX}${hash}`;
}

/**
 * Mint a ticket for an authenticated principal.
 *
 * Only ever called from a route behind `authenticate()`, so the principal has
 * already been proven by a cookie session or a bearer. The ticket inherits that
 * proof and nothing else - notably NOT the ability to widen its own scope: the
 * tenant is fixed at mint time and a socket cannot ask for another one.
 */
export async function issueRealtimeTicket(
  principal: JwtPayload,
  ttlSeconds: number = REALTIME_TICKET_TTL_SECONDS,
): Promise<{ ticket: string; expiresInSeconds: number }> {
  const ticket = crypto.randomBytes(TICKET_BYTES).toString("base64url");
  const payload: RealtimeTicketPrincipal = {
    userId: principal.userId,
    identityId: principal.identityId,
    tenantId: principal.tenantId,
    role: principal.role,
    email: principal.email,
    departmentId: principal.departmentId,
    departmentRole: principal.departmentRole,
  };
  await getRedis().set(ticketKey(ticket), JSON.stringify(payload), "EX", ttlSeconds);
  return { ticket, expiresInSeconds: ttlSeconds };
}

/**
 * Redeem a ticket, exactly once.
 *
 * Read and delete are ONE atomic Redis command. A read followed by a delete
 * would let two sockets racing on the same ticket both succeed - which is the
 * entire property being sold here, so it cannot be left to a sequence of two
 * round trips.
 *
 * Returns null for every failure - unknown, expired, already spent, malformed,
 * or corrupt. The caller must treat null as "reject the handshake" and must not
 * distinguish the cases to the client.
 */
export async function redeemRealtimeTicket(
  ticket: unknown,
): Promise<RealtimeTicketPrincipal | null> {
  if (!isWellFormedRealtimeTicket(ticket)) return null;
  const redis = getRedis();
  let raw: string | null;
  try {
    // GETDEL landed in Redis 6.2; the compose image is 7. Fall back to a
    // single-key Lua eval if a deployment ever runs older, rather than
    // silently degrading to a non-atomic get+del.
    raw = await (redis as any).getdel(ticketKey(ticket));
  } catch {
    try {
      raw = (await redis.eval(
        "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v",
        1,
        ticketKey(ticket),
      )) as string | null;
    } catch {
      return null;
    }
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RealtimeTicketPrincipal;
    if (!parsed?.userId || !parsed?.tenantId) return null;
    return parsed;
  } catch {
    return null;
  }
}
