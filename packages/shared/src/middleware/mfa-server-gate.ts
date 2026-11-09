import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { mfaRequirementFor, isEnrolledWithRecovery } from "../lib/mfa";

/**
 * The server's MFA gate, for every human principal that authenticate() admits
 * (prod 2026-11-09: a new SYSTEM_ADMIN used the console with no MFA; the
 * per-router enforceMfaEnrollment ran only on /api/agents and /api/departments,
 * and the Authentik validation stage skips users with no device).
 *
 * A user whose role + tenant policy REQUIRE MFA (mfaRequirementFor: SYSTEM_ADMIN
 * always) and who is not enrolled (an authenticator AND recovery codes, the
 * identity's mfaEnrolledAt stamp) gets 403 { error: "mfa_enrollment_required",
 * reason } on every route except the few needed to enrol and to leave: the
 * account's security / mfa-gate reads, /api/auth/me, logout.
 *
 * Enrolment itself happens in Authentik. The stamp is refreshed by the account
 * /mfa-gate check and, where this process can reach Authentik (the auth
 * service), by a live check here on a miss (cached a minute), so a user who
 * just enrolled is let in on their next /api/auth/me without any UI change.
 * An Authentik error never lets an unstamped user in.
 *
 * Support mode is gated on the ADMIN's own MFA. Internal service calls are
 * never gated. MFA_SERVER_GATE=off switches it off (an incident lever).
 */

const EXEMPT: Array<{ method?: string; re: RegExp }> = [
  { re: /^\/api\/account\/mfa-gate\/?$/ },
  { re: /^\/api\/account\/security(\/|$)/ },
  { method: "GET", re: /^\/api\/account\/?$/ },
  { re: /^\/api\/auth\/me(\/memberships)?\/?$/ },
  { re: /^\/api\/auth\/logout\/?$/ },
  { re: /^\/api\/auth\/(login|callback)(\/|$)/ },
];

export function mfaGateExempt(method: string, url: string): boolean {
  const path = String(url || "").split("?")[0];
  return EXEMPT.some((e) => (!e.method || e.method === String(method || "").toUpperCase()) && e.re.test(path));
}

type Verdict = { ok: true } | { ok: false; reason: string | null };
const verdicts = new Map<string, { at: number; v: Verdict }>();
const VERDICT_TTL_MS = 60_000;
const live = new Map<string, { at: number; enrolled: boolean }>();
const LIVE_TTL_MS = 60_000;

/**
 * Someone who keeps Authentik's "gotcha_mfa_required" marker in step (the auth
 * service): told the identity whenever a verdict is computed. Never awaited,
 * never able to fail the request.
 */
let requirementObserver: ((identityId: string) => void) | null = null;
export function observeMfaRequirement(fn: ((identityId: string) => void) | null): void { requirementObserver = fn; }

/** Test seam: forget cached verdicts. */
export function resetMfaGateCache(): void { verdicts.clear(); live.clear(); }

function canReachIdp(): boolean {
  return !!process.env.AUTHENTIK_URL && !!(process.env.AUTHENTIK_API_TOKEN || process.env.AUTHENTIK_BOOTSTRAP_TOKEN);
}

/** Authentik's word on this identity (an authenticator AND recovery codes), cached; null when it cannot be asked. */
async function liveEnrolled(identityId: string, subject: string | null): Promise<boolean | null> {
  if (!subject || !canReachIdp()) return null;
  const hit = live.get(identityId);
  if (hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.enrolled;
  try {
    const { findIdentityBySubject, listUserDevices } = await import("../lib/authentik");
    const who = await findIdentityBySubject(subject);
    if (!who) return null;
    const enrolled = isEnrolledWithRecovery(await listUserDevices(who.pk));
    live.set(identityId, { at: Date.now(), enrolled });
    return enrolled;
  } catch (err: any) {
    console.warn(`[mfa-gate] live check failed for identity=${identityId}: ${err?.message ?? err}`);
    return null;
  }
}

async function verdictFor(userId: string): Promise<Verdict> {
  const hit = verdicts.get(userId);
  if (hit && Date.now() - hit.at < VERDICT_TTL_MS) return hit.v;
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true, identityId: true,
      identity: { select: { mfaEnrolledAt: true, authentikSubject: true } },
      tenant: { select: { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: true } },
    },
  });
  if (!row) return { ok: true }; // no such user: authenticate() already decided who this is
  const need = mfaRequirementFor(row.role, {
    mfaRequiredForAdmins: !!row.tenant?.mfaRequiredForAdmins,
    mfaRequiredForAllUsers: !!row.tenant?.mfaRequiredForAllUsers,
  });
  if (requirementObserver && row.identityId) { try { requirementObserver(row.identityId); } catch { /* never the request's problem */ } }
  let v: Verdict = { ok: true };
  if (need.required && row.identity?.mfaEnrolledAt == null) {
    const now = await liveEnrolled(row.identityId, row.identity?.authentikSubject ?? null);
    if (now === true) {
      await prisma.identity.update({ where: { id: row.identityId }, data: { mfaEnrolledAt: new Date() } }).catch(() => {});
    } else {
      v = { ok: false, reason: need.reason };
    }
  }
  // Only a pass is cached: a refusal is re-read, so enrolling lets the user in at once.
  if (v.ok) verdicts.set(userId, { at: Date.now(), v });
  if (verdicts.size > 5000) verdicts.clear();
  return v;
}

/**
 * Called by authenticate() in place of next() once a human principal is known.
 * `userId` is the person whose MFA counts (the admin in support mode).
 */
export async function mfaServerGate(req: Request, res: Response, next: NextFunction, userId: string | null | undefined): Promise<void> {
  if (process.env.MFA_SERVER_GATE === "off" || !userId || userId === "system") { next(); return; }
  const exempt = mfaGateExempt(req.method, req.originalUrl || req.url);
  let v: Verdict;
  try {
    v = await verdictFor(userId);
  } catch (err: any) {
    // A local database error: not a reason to lock the whole product out (the
    // request itself would fail on the same database a moment later).
    console.warn(`[mfa-gate] check failed for user=${userId}: ${err?.message ?? err}`);
    next();
    return;
  }
  if (v.ok || exempt) { next(); return; }
  res.status(403).json({ error: "mfa_enrollment_required", reason: v.reason });
}
