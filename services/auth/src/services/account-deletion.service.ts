/**
 * Account deletion requests (Google Play / App Store "delete your account",
 * Omer 2026-11-14). Contract: release-next-kit/account-deletion/CONTRACT.md,
 * agreed with Frontend.
 *
 * A person ASKS here; nothing is deleted automatically. An operator completes
 * a confirmed request through the existing GDPR erasure (gdpr.service:
 * eraseUser, which also removes the Authentik identity on the last
 * membership; eraseTenant for a workspace the person owns alone).
 *
 * Abuse-safe without a captcha:
 *   - the public answer is the same whether or not the address has an account,
 *     so the form cannot be used to learn who is a customer;
 *   - mail goes only to an address that HAS an account, never to a stranger;
 *   - limits per IP and per address, and one resend per 15 minutes;
 *   - the emailed token is stored only as a sha256 hash, lives 24 hours, and is
 *     spent only by the person's own POST (never by opening the link).
 */
import crypto from "crypto";
import { prisma, getRedis, withCrossTenantAccess, resolveAppPublicUrl } from "@chatcenter/shared";
import { eraseUser, eraseTenant, tenantDeletionRefusal } from "./gdpr.service";
import { sendAccountDeletionConfirmEmail, sendAccountDeletionNoticeEmail } from "./notification.service";

export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const DELETE_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;
export const RESEND_GAP_MS = 15 * 60 * 1000;
export const LIMITS = { perIpPerHour: 5, perEmailPerDay: 3 };
const OPEN = ["PENDING_VERIFICATION", "VERIFIED"];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export class DeletionError extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) { super(code); }
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const normalizeEmail = (raw: unknown) => (typeof raw === "string" ? raw.trim().toLowerCase() : "");
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local[0]}***@${domain}`;
}
function ipHash(ip: string | undefined): string | null {
  if (!ip) return null;
  return sha256(`${ip}|${process.env.ACCOUNT_DELETION_IP_SALT || process.env.INTERNAL_SERVICE_KEY || "gotcha"}`);
}

/** Fixed-window counter in Redis. Returns seconds to wait when over the limit. */
async function overLimit(key: string, max: number, windowSec: number): Promise<number | null> {
  const redis = getRedis();
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSec);
  if (n <= max) return null;
  const ttl = await redis.ttl(key);
  return ttl > 0 ? ttl : windowSec;
}

function confirmUrl(token: string, locale: "he" | "en"): string {
  return `${resolveAppPublicUrl(process.env)}/${locale}/account-deletion/confirm?token=${encodeURIComponent(token)}`;
}

/** POST /request (public). Always resolves { accepted: true } for a well-formed address. */
export async function requestPublic(input: { email: unknown; workspace?: unknown; locale?: unknown; ip?: string }): Promise<{ accepted: true }> {
  const email = normalizeEmail(input.email);
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw new DeletionError(400, "BAD_EMAIL");
  const workspace = typeof input.workspace === "string" ? input.workspace.trim().slice(0, 120) || null : null;
  const locale: "he" | "en" = input.locale === "en" ? "en" : "he";

  const ipKey = ipHash(input.ip);
  if (ipKey) {
    const wait = await overLimit(`acctdel:ip:${ipKey}`, LIMITS.perIpPerHour, 3600);
    if (wait) throw new DeletionError(429, "RATE_LIMITED", { retryAfter: wait });
  }
  const wait = await overLimit(`acctdel:email:${sha256(email)}`, LIMITS.perEmailPerDay, 86400);
  if (wait) throw new DeletionError(429, "RATE_LIMITED", { retryAfter: wait });

  // No account: the same answer, no row, no mail. Storing a stranger's
  // address, or mailing it, is exactly what this must never do.
  const identity = await prisma.identity.findUnique({ where: { email }, select: { id: true, name: true } });
  if (!identity) return { accepted: true };

  const open = await prisma.accountDeletionRequest.findFirst({
    where: { email, status: "PENDING_VERIFICATION" },
    orderBy: { createdAt: "desc" },
  });
  if (open && Date.now() - open.updatedAt.getTime() < RESEND_GAP_MS) return { accepted: true };

  const token = crypto.randomBytes(32).toString("base64url");
  const data = {
    tokenHash: sha256(token),
    tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    workspaceName: workspace,
    ipHash: ipKey,
  };
  if (open) {
    await prisma.accountDeletionRequest.update({ where: { id: open.id }, data });
  } else {
    await prisma.accountDeletionRequest.create({
      data: { ...data, email, source: "public", identityId: identity.id, status: "PENDING_VERIFICATION" },
    });
  }
  await sendAccountDeletionConfirmEmail(email, identity.name ?? "", confirmUrl(token, locale), locale)
    .catch((err: any) => console.error("[account-deletion] confirmation email failed:", err?.message));
  return { accepted: true };
}

/** POST /confirm (public). Spends the token. Deletes nothing: it queues the request for an operator. */
export async function confirm(rawToken: unknown): Promise<{ status: "scheduled"; deleteBy: string; email: string }> {
  if (typeof rawToken !== "string" || rawToken.length < 20 || rawToken.length > 200) throw new DeletionError(400, "BAD_TOKEN");
  const row = await prisma.accountDeletionRequest.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (!row) throw new DeletionError(400, "BAD_TOKEN");
  if (row.status !== "PENDING_VERIFICATION") throw new DeletionError(409, "ALREADY_CONFIRMED");
  if (!row.tokenExpiresAt || row.tokenExpiresAt.getTime() < Date.now()) {
    await prisma.accountDeletionRequest.update({ where: { id: row.id }, data: { status: "EXPIRED" } });
    throw new DeletionError(410, "TOKEN_EXPIRED");
  }
  // Guarded on the status, so two clicks cannot both confirm.
  const verifiedAt = new Date();
  const r = await prisma.accountDeletionRequest.updateMany({
    where: { id: row.id, status: "PENDING_VERIFICATION" },
    data: { status: "VERIFIED", verifiedAt },
  });
  if (r.count !== 1) throw new DeletionError(409, "ALREADY_CONFIRMED");
  return { status: "scheduled", deleteBy: new Date(verifiedAt.getTime() + DELETE_WITHIN_MS).toISOString(), email: maskEmail(row.email) };
}

// ─── In-app (signed in) ─────────────────────────────────────

const publicView = (r: any) => r && ({ id: r.id, status: r.status, createdAt: r.createdAt, verifiedAt: r.verifiedAt });

async function me(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, tenantId: true, identityId: true, identity: { select: { email: true, name: true } } } as any,
  });
  if (!user) throw new DeletionError(404, "NOT_FOUND");
  return user as any;
}

/** POST /me. The signed-in session is the proof, so it is VERIFIED at once; a notice mail goes to the account's address. */
export async function requestInApp(userId: string, reason?: unknown) {
  const user = await me(userId);
  const open = await prisma.accountDeletionRequest.findFirst({ where: { identityId: user.identityId, status: { in: OPEN } } });
  if (open) throw new DeletionError(409, "ALREADY_REQUESTED", { data: publicView(open) });
  const email = normalizeEmail(user.identity.email);
  const row = await prisma.accountDeletionRequest.create({
    data: {
      email, source: "in_app", identityId: user.identityId, userId: user.id, tenantId: user.tenantId,
      reason: typeof reason === "string" ? reason.slice(0, 500) || null : null,
      status: "VERIFIED", verifiedAt: new Date(),
    },
  });
  await sendAccountDeletionNoticeEmail(email, user.identity.name ?? "")
    .catch((err: any) => console.error("[account-deletion] notice email failed:", err?.message));
  return publicView(row);
}

export async function getMine(userId: string) {
  const user = await me(userId);
  const row = await prisma.accountDeletionRequest.findFirst({
    where: { identityId: user.identityId, status: { in: OPEN } }, orderBy: { createdAt: "desc" },
  });
  return publicView(row) ?? null;
}

export async function cancelMine(userId: string) {
  const user = await me(userId);
  const r = await prisma.accountDeletionRequest.updateMany({
    where: { identityId: user.identityId, status: { in: OPEN } },
    data: { status: "CANCELLED", tokenHash: null },
  });
  if (r.count === 0) throw new DeletionError(404, "NOTHING_OPEN");
  return { cancelled: r.count };
}

// ─── Operator (SYSTEM_ADMIN) ────────────────────────────────

type Membership = { userId: string; tenantId: string; tenantName: string | null; role: string; members: number; admins: number };

async function membershipsOf(identityId: string | null): Promise<Membership[]> {
  if (!identityId) return [];
  const users = await withCrossTenantAccess(() => prisma.user.findMany({
    where: { identityId }, select: { id: true, tenantId: true, role: true, tenant: { select: { name: true } } } as any,
  })) as any[];
  const out: Membership[] = [];
  for (const u of users) {
    const [members, admins] = await withCrossTenantAccess(() => Promise.all([
      prisma.user.count({ where: { tenantId: u.tenantId } }),
      prisma.user.count({ where: { tenantId: u.tenantId, role: "ADMIN" } }),
    ]));
    out.push({ userId: u.id, tenantId: u.tenantId, tenantName: u.tenant?.name ?? null, role: u.role, members, admins });
  }
  return out;
}

export async function listForOperator(status?: string) {
  const rows = await prisma.accountDeletionRequest.findMany({
    where: status ? { status } : {}, orderBy: { createdAt: "desc" }, take: 200,
  });
  return Promise.all(rows.map(async (r) => ({
    ...r, tokenHash: undefined, ipHash: undefined,
    memberships: (await membershipsOf(r.identityId)).map((m) => ({
      ...m, lastOwner: m.role === "ADMIN" && m.admins === 1 && m.members > 1, soleMember: m.members === 1,
    })),
  })));
}

/**
 * Complete a VERIFIED request. Refuses, with the list, rather than guess:
 *   - SYSTEM_ADMIN: never erased here;
 *   - LAST_OWNER: the only admin of a workspace that has other members
 *     (ownership moves first, or the business asks for the workspace);
 *   - SOLE_MEMBER_WORKSPACE: a workspace with only this person in it is erased
 *     whole only when the operator names it in eraseWorkspaces.
 */
export async function complete(id: string, operatorId: string, opts: { eraseWorkspaces?: string[] } = {}) {
  const row = await prisma.accountDeletionRequest.findUnique({ where: { id } });
  if (!row) throw new DeletionError(404, "NOT_FOUND");
  if (row.status !== "VERIFIED") throw new DeletionError(409, "NOT_VERIFIED", { status: row.status });
  const ms = await membershipsOf(row.identityId);
  if (ms.some((m) => m.role === "SYSTEM_ADMIN")) throw new DeletionError(409, "SYSTEM_ADMIN");
  const lastOwner = ms.filter((m) => m.role === "ADMIN" && m.admins === 1 && m.members > 1);
  if (lastOwner.length) throw new DeletionError(409, "LAST_OWNER", { workspaces: lastOwner.map((m) => ({ tenantId: m.tenantId, name: m.tenantName })) });
  const named = new Set(opts.eraseWorkspaces ?? []);
  const sole = ms.filter((m) => m.members === 1);
  const unnamed = sole.filter((m) => !named.has(m.tenantId));
  if (unnamed.length) throw new DeletionError(409, "SOLE_MEMBER_WORKSPACE", { workspaces: unnamed.map((m) => ({ tenantId: m.tenantId, name: m.tenantName })) });
  for (const m of sole) {
    const refusal = await tenantDeletionRefusal(m.tenantId);
    if (refusal) throw new DeletionError(409, "WORKSPACE_NOT_ERASABLE", { tenantId: m.tenantId, refusal });
  }

  const result: Array<Record<string, unknown>> = [];
  // Memberships in shared workspaces first, the person's own workspaces last:
  // the Authentik identity goes with the LAST membership either way.
  for (const m of ms.filter((x) => x.members > 1)) {
    const r = await eraseUser(m.tenantId, m.userId, operatorId);
    result.push({ tenantId: m.tenantId, erased: "user", ...(r ?? {}) });
  }
  for (const m of sole) {
    const r: any = await eraseTenant(m.tenantId, operatorId, { reason: `account deletion request ${row.id}` });
    result.push({ tenantId: m.tenantId, erased: "workspace", ...(r && typeof r === "object" ? { counts: r.counts ?? undefined } : {}) });
  }
  await prisma.accountDeletionRequest.update({
    where: { id }, data: { status: "COMPLETED", completedAt: new Date(), completedBy: operatorId, tokenHash: null, result: result as any },
  });
  return { status: "COMPLETED", result };
}

export async function reject(id: string, operatorId: string, reason: unknown) {
  const r = await prisma.accountDeletionRequest.updateMany({
    where: { id, status: { in: OPEN } },
    data: { status: "REJECTED", rejectedReason: typeof reason === "string" ? reason.slice(0, 500) : null, completedBy: operatorId, tokenHash: null },
  });
  if (r.count === 0) throw new DeletionError(404, "NOTHING_OPEN");
  return { status: "REJECTED" };
}
