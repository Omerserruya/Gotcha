/**
 * The public sign-up, after the form has been read and answered.
 *
 * The route answers "check your email" BEFORE any of this runs, and it answers
 * the same to everyone. That is what keeps the form from telling a stranger
 * which addresses are customers: there is one answer and one response time,
 * whatever happens here. The price is that a failure here has no screen to
 * appear on, so every failure is logged with enough to act on.
 *
 * Three ends:
 *   - the address already has an account: nothing is created. The person gets
 *     the sign-in hint, or a fresh set-password link when they never finished
 *     setting one;
 *   - a new organization, made by the same function the console's "new
 *     organization" uses, in trial mode, with the days and credits the
 *     platform settings name today;
 *   - nothing, when sign-up is closed or the same address is already being
 *     handled.
 */
import crypto from "crypto";
import {
  prisma,
  withCrossTenantAccess,
  writeAudit,
  AuditAction,
  LEGAL_VERSIONS,
  findIdentityBySubject,
  getUserLastLogin,
  writeDurableSetting,
  selfSignupState,
  newSelfSignupOrigin,
  SELF_SIGNUP_ORIGIN_KEY,
} from "@chatcenter/shared";
import { createTenantWithAdmin, LICENSE_DOMAINS } from "./tenant-creation.service";
import { sendSetupLinkEmail, sendSignInHintEmail } from "./notification.service";
import { termsConsentRows } from "../lib/terms-consent";
import { signupSlug, type SignupInput } from "../lib/self-signup-input";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the console shows next to a trial that nobody on our side opened. */
export const SELF_SIGNUP_NOTE = "Self sign-up";

export interface SelfSignupRequest extends SignupInput {
  /** The visitor's address and browser, kept as evidence of the acceptance. */
  ip: string | null;
  userAgent: string | null;
}

export type SelfSignupOutcome =
  | { kind: "created"; tenantId: string }
  /** The organization exists but its plan setup did not complete: no email went out; the console can repair it. */
  | { kind: "created_incomplete"; tenantId: string }
  | { kind: "existing_sign_in_hint" }
  | { kind: "existing_setup_link" }
  /** An account that cannot be mailed anything true: no way to sign in, or no organization to set a password into. */
  | { kind: "existing_no_mail" }
  | { kind: "duplicate_in_flight" }
  | { kind: "closed" }
  | { kind: "failed"; reason: string };

/**
 * Addresses being handled right now. A double click sends the form twice
 * within milliseconds, and both would pass "no account yet" and open two
 * organizations for one person. The second is dropped; the first one's email
 * is the answer to both.
 */
const inFlight = new Set<string>();

export async function runSelfSignup(req: SelfSignupRequest, now: Date = new Date()): Promise<SelfSignupOutcome> {
  if (inFlight.has(req.email)) return { kind: "duplicate_in_flight" };
  inFlight.add(req.email);
  try {
    const outcome = await handle(req, now);
    if (outcome.kind === "failed" || outcome.kind === "created_incomplete") {
      console.error(`[self-signup] ${outcome.kind}:`, JSON.stringify({ ...outcome, emailDomain: req.email.split("@")[1] }));
    } else {
      console.log(`[self-signup] ${outcome.kind}`);
    }
    return outcome;
  } catch (err) {
    const reason = (err as Error)?.message ?? String(err);
    console.error("[self-signup] failed:", reason);
    return { kind: "failed", reason };
  } finally {
    inFlight.delete(req.email);
  }
}

async function handle(req: SelfSignupRequest, now: Date): Promise<SelfSignupOutcome> {
  // Read again, although the route already checked: the settings may have been
  // switched off in between, and the days and credits come from this read.
  const state = await selfSignupState();
  if (!state.open) return { kind: "closed" };

  const identity = await prisma.identity.findUnique({
    where: { email: req.email },
    select: { id: true, authentikSubject: true },
  });
  if (identity) return existingPerson(identity, req);

  return newOrganization(req, state, now);
}

/**
 * The address already has an account. Nothing is created.
 *
 * Someone who has signed in has a password, and a "set your password" link in
 * their inbox reads like a phish; they get the sign-in hint. Someone who never
 * signed in cannot use a sign-in hint; they get a fresh set-password link into
 * the organization they were invited to. When Authentik cannot say which of
 * the two this is, it reads as "has signed in": the hint is harmless to both.
 */
async function existingPerson(
  identity: { id: string; authentikSubject: string | null },
  req: SelfSignupRequest,
): Promise<SelfSignupOutcome> {
  // A row with no Authentik subject is a person who can never sign in.
  if (!identity.authentikSubject) return { kind: "existing_no_mail" };

  const member = await withCrossTenantAccess(() =>
    prisma.user.findFirst({
      where: { identityId: identity.id, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, tenantId: true },
    }),
  );

  let signedIn = true;
  try {
    const authentik = await findIdentityBySubject(identity.authentikSubject);
    if (authentik) signedIn = (await getUserLastLogin(authentik.pk)) != null;
  } catch {
    signedIn = true;
  }

  if (signedIn) {
    await sendSignInHintEmail(req.email, req.locale, member?.tenantId ?? null);
    return { kind: "existing_sign_in_hint" };
  }
  if (!member) return { kind: "existing_no_mail" };
  await sendSetupLinkEmail(member.id);
  return { kind: "existing_setup_link" };
}

async function newOrganization(
  req: SelfSignupRequest,
  settings: { enabled: boolean; trialDays: number; cardRequiredAfterDays: number; trialCredits: number },
  now: Date,
): Promise<SelfSignupOutcome> {
  const expiresAt = new Date(now.getTime() + settings.trialDays * DAY_MS).toISOString();

  // The address name carries a random ending, so a taken one is a coincidence;
  // one more draw settles it.
  let outcome = await create(req, settings.trialCredits, expiresAt);
  if (outcome.status === 409) outcome = await create(req, settings.trialCredits, expiresAt);

  if (!outcome.created) {
    return { kind: "failed", reason: `tenant creation refused: ${outcome.status} ${outcome.body?.code ?? outcome.body?.error ?? ""}`.trim() };
  }
  const { tenantId, adminUserId } = outcome.created;

  // The mark is what the card sweep looks for, and it is a SNAPSHOT: this
  // organization keeps the days it was promised today, whatever the settings
  // say next month. An organization without a readable mark is never swept,
  // so a failure here costs us a reminder and blocks nobody.
  try {
    await writeDurableSetting(tenantId, SELF_SIGNUP_ORIGIN_KEY, JSON.stringify(newSelfSignupOrigin(settings, now)));
  } catch (err) {
    console.error("[self-signup] the organization's mark was not written:", tenantId, (err as Error)?.message);
  }

  await recordAcceptance(tenantId, adminUserId, req, now).catch((err) =>
    console.error("[self-signup] the Terms acceptance was not recorded:", tenantId, (err as Error)?.message),
  );

  return outcome.status === 201 ? { kind: "created", tenantId } : { kind: "created_incomplete", tenantId };
}

function create(req: SelfSignupRequest, credits: number, expiresAt: string) {
  return createTenantWithAdmin({
    name: req.businessName,
    slug: signupSlug(req.businessName, crypto.randomBytes(3).toString("hex")),
    adminEmail: req.email,
    adminName: req.name,
    locale: req.locale,
    billing: {
      mode: "POC",
      pocCredits: credits,
      pocExpiresAt: expiresAt,
      pocFeatureAreas: LICENSE_DOMAINS,
      commercialNote: SELF_SIGNUP_NOTE,
    },
    // Nobody on our side opened this organization; the form did.
    actor: { type: "system", id: null },
  });
}

/**
 * The two boxes ticked on the form, written the way the set-password screen
 * writes them: one row per document, each naming its address and version.
 */
async function recordAcceptance(tenantId: string, userId: string, req: SelfSignupRequest, now: Date): Promise<void> {
  const source = "self_signup" as const;
  const rows = termsConsentRows({
    tenantId,
    userId,
    source,
    locale: req.locale,
    evidence: {
      ip: req.ip,
      userAgent: req.userAgent ? req.userAgent.slice(0, 500) : null,
      capturedText: req.capturedText,
      locale: req.locale,
      channel: "self_signup",
      acceptedAt: now.toISOString(),
    },
  });
  await withCrossTenantAccess(() => prisma.$transaction(rows.map((data) => prisma.consentRecord.create({ data }))));
  void writeAudit({
    tenantId,
    actorType: "user",
    actorId: userId,
    action: AuditAction.CONSENT_GRANTED,
    targetType: "user",
    targetId: userId,
    metadata: { purposes: rows.map((r) => r.purpose), versions: LEGAL_VERSIONS, source, locale: req.locale },
  });
}
