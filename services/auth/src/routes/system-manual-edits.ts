import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  prisma,
  authenticate,
  requireSystemAdmin,
  validate,
  crossTenantMiddleware,
  getInternalServiceKey,
  writeAudit,
  AuditAction,
  resolveTenantPlanAccess,
  findIdentityBySubject,
  findIdentityByEmail,
  updateIdentity,
  deleteOAuthSourceConnection,
} from "@chatcenter/shared";
import { emailChangeGoogleStep } from "../lib/google-sign-in";

/**
 * SYSTEM_ADMIN console: manual edits to one organization (Omer, 2026-10-23).
 *
 *   PATCH /api/system/tenants/:id/status          set the status, no payment or onboarding gate
 *   PATCH /api/system/tenants/:id/admin-email     change a member's login email, Authentik included
 *   POST  /api/system/tenants/:id/billing/manual  plan, end date, POC or credits - never a charge
 *
 * Every write takes the operator's `reason` and writes one audit row whose
 * metadata is { before, after, reason }; every response carries the same
 * before/after plus the organization's resulting planAccess, so the console
 * can say "ACTIVE, but no plan" instead of implying the edit granted access.
 *
 * Adding and removing users stay on the existing /tenants/:id/users routes.
 */
const router = Router();

// Same opt-out as the main system router, for the same reason: these handlers
// read one named tenant's rows from a SYSTEM_ADMIN session that belongs to no
// tenant. Every handler is gated by authenticate + requireSystemAdmin().
router.use(crossTenantMiddleware);

import { hasOpenCheckout } from "../services/billing-checkout";
const BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "http://billing:4009";

const reason = z.string().trim().min(1).max(500);

/** Checkout states that mean the customer could still pay. */

async function planAccessView(tenantId: string) {
  const p = await resolveTenantPlanAccess(tenantId);
  return {
    state: p.state,
    label: p.label,
    active: p.active,
    planKey: p.planKey,
    planName: p.planName,
    expiresAt: p.expiresAt,
  };
}

function actorOf(req: Request): string | undefined {
  return (req as any).user?.userId;
}

// ─── Status ──────────────────────────────────────────────────

const statusSchema = z.object({
  status: z.enum(["ACTIVE", "PENDING_ONBOARDING", "PENDING_PAYMENT", "SUSPENDED"]),
  reason,
}).strict();

/**
 * Set the status by hand. Writes Tenant.status and nothing else: no payment,
 * no onboarding step, no email, no subscription change.
 *
 * The status is half of access. The request gate also asks for an active plan
 * source, so the warnings say when this edit will not do what it looks like,
 * and which billing event would overwrite it later.
 */
router.patch("/tenants/:id/status", authenticate, requireSystemAdmin(), validate(statusSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.params.id as string;
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, status: true } });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found", code: "TENANT_NOT_FOUND" });
      return;
    }
    const { status } = req.body as { status: string; reason: string };
    const before = { status: tenant.status };

    if (tenant.status !== status) {
      await prisma.tenant.update({ where: { id: tenantId }, data: { status: status as any } });
      void writeAudit({
        tenantId, actorType: "user", actorId: actorOf(req),
        action: AuditAction.TENANT_STATUS_SET_MANUALLY, targetType: "tenant", targetId: tenantId,
        metadata: { before, after: { status }, reason: req.body.reason },
      });
    }

    const planAccess = await planAccessView(tenantId);
    const warnings: string[] = [];
    if (status === "ACTIVE" && !planAccess.active) warnings.push("no_access_source");

    const [checkout, link] = await Promise.all([
      hasOpenCheckout(tenantId),
      prisma.billableEntityTenant.findFirst({
        where: { tenantId },
        select: { entity: { select: { subscription: { select: { status: true, cancelAtPeriodEnd: true } } } } },
      }),
    ]);
    // Completing a checkout writes ACTIVE or PENDING_ONBOARDING over this.
    if (checkout) warnings.push("open_checkout");
    if (checkout === null) warnings.push("open_checkout_unknown");
    const sub = link?.entity?.subscription;
    // Dunning suspends an ACTIVE tenant when it gives up.
    if (sub?.status === "PAST_DUE") warnings.push("billing_may_resuspend");
    // A successful renewal un-suspends: a manual SUSPENDED lasts until then.
    if (status === "SUSPENDED" && sub?.status === "ACTIVE" && !sub.cancelAtPeriodEnd) warnings.push("renewal_will_unsuspend");

    res.json({ data: { before, after: { status }, planAccess, warnings } });
  } catch (err) {
    console.error("Set tenant status error:", err);
    res.status(500).json({ error: "Failed to set tenant status" });
  }
});

// ─── Login email ─────────────────────────────────────────────

const emailSchema = z.object({
  userId: z.string().min(1),
  newEmail: z.string().trim().email().max(254),
  reason,
}).strict();

/**
 * Change a member's login email, in Authentik and here.
 *
 * Authentik owns the identity, so it is written FIRST: if it refuses, nothing
 * local has changed and the operator is told so. The password is never
 * touched, and live sessions are deliberately left alone - a session is bound
 * to the immutable Authentik subject, not to the email, so it stays the same
 * person's session after the change.
 *
 * Refused when the identity also belongs to other organizations: one Identity
 * is one login across every tenant, and an operator editing this tenant must
 * not move a person's login everywhere else. The console offers the other
 * route instead - invite the new address, then remove the old member.
 *
 * A Google connection goes with the old address (it was made by matching it),
 * and the answer's warnings say so. While that connection is the person's only
 * way in, the change is refused: NO_OTHER_SIGN_IN, nothing changed.
 */
router.patch("/tenants/:id/admin-email", authenticate, requireSystemAdmin(), validate(emailSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.params.id as string;
    const { userId } = req.body as { userId: string };
    const newEmail = (req.body.newEmail as string).toLowerCase();

    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: {
        id: true, email: true, role: true, identityId: true,
        identity: { select: { id: true, email: true, authentikSubject: true } },
      },
    });
    if (!user) {
      res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
      return;
    }
    if (user.role === "SYSTEM_ADMIN") {
      res.status(400).json({ error: "A system admin's email is not edited from a tenant", code: "SYSTEM_ADMIN" });
      return;
    }
    if (user.email.toLowerCase() === newEmail) {
      res.status(400).json({ error: "That is already this member's email", code: "SAME_EMAIL" });
      return;
    }

    const clash = await prisma.user.findFirst({
      where: { tenantId, email: { equals: newEmail, mode: "insensitive" }, id: { not: user.id } },
      select: { id: true },
    });
    if (clash) {
      res.status(409).json({ error: "Another member of this organization uses that email", code: "EMAIL_TAKEN" });
      return;
    }

    const identity = user.identity;
    if (identity) {
      const others = await prisma.user.count({ where: { identityId: identity.id, id: { not: user.id } } });
      if (others > 0) {
        res.status(409).json({
          error: "This person also belongs to other organizations; changing the email would move their login everywhere",
          code: "IDENTITY_SHARED",
        });
        return;
      }
      const taken = await prisma.identity.findFirst({ where: { email: newEmail, id: { not: identity.id } }, select: { id: true } });
      if (taken) {
        res.status(409).json({ error: "Another login already uses that email", code: "EMAIL_TAKEN" });
        return;
      }
    }

    // Authentik first. Without a subject there is no IdP user to move, and the
    // local rows are all there is.
    let idp: { pk: number; email: string; username: string } | null = null;
    // Set once the person's Google connection has been removed, so every answer
    // after that point says so, a failure's too.
    let googleRemoved = false;
    const removedNote = () => (googleRemoved ? { warnings: ["google_connection_removed"] } : {});
    if (identity?.authentikSubject) {
      try {
        const found = await findIdentityBySubject(identity.authentikSubject);
        if (!found) {
          res.status(502).json({ error: "The login was not found in Authentik; nothing was changed", code: "IDP_SYNC_FAILED" });
          return;
        }
        const owner = await findIdentityByEmail(newEmail);
        if (owner && owner.subject !== identity.authentikSubject) {
          res.status(409).json({ error: "Another login already uses that email", code: "EMAIL_TAKEN" });
          return;
        }
        // The Google connection was made by matching the old address, so it
        // goes with it, and the change is refused while it is the person's
        // only way in (lib/google-sign-in). It goes before the email moves: a
        // failure after this point leaves the person their password, where the
        // other order could leave the old Google account opening a login that
        // now carries a new address.
        const google = await emailChangeGoogleStep(found.pk);
        if (google.state === "blocked") {
          res.status(409).json({
            error: "This person signs in with Google only; changing the email would remove that and leave them no way in. They need a password first",
            code: "NO_OTHER_SIGN_IN",
          });
          return;
        }
        if (google.state === "remove") {
          await deleteOAuthSourceConnection(google.connectionId);
          googleRemoved = true;
          void writeAudit({
            tenantId, actorType: "user", actorId: actorOf(req),
            action: AuditAction.SIGN_IN_CONNECTION_REMOVED, targetType: "user", targetId: user.id,
            metadata: { self: false, provider: "google", reason: "email_change" },
          });
        }
        idp = { pk: found.pk, email: found.email, username: found.username };
        // Usernames were created as the email; one that was changed on purpose
        // is not ours to overwrite.
        const movesUsername = (found.username ?? "").toLowerCase() === (found.email ?? "").toLowerCase();
        try {
          await updateIdentity(found.pk, { email: newEmail, ...(movesUsername ? { username: newEmail } : {}) });
        } catch (err: any) {
          // A throw is not proof Authentik refused: a timeout can land after
          // the change applied. Read back what Authentik now holds and follow
          // it, so the two systems never drift apart.
          console.error("Admin email: Authentik update threw:", err?.message ?? err);
          const now = await findIdentityBySubject(identity.authentikSubject);
          if ((now?.email ?? "").toLowerCase() !== newEmail) {
            res.status(502).json({
              error: googleRemoved
                ? "Authentik did not accept the change; the email was not changed, and the Google connection was removed"
                : "Authentik did not accept the change; nothing was changed",
              code: "IDP_SYNC_FAILED",
              ...removedNote(),
            });
            return;
          }
        }
      } catch (err: any) {
        // Authentik could not be read, before or after the change: what it
        // holds is unknown, so nothing local is written. Retrying is safe -
        // the new email resolving to this same login is not a clash.
        console.error("Admin email: Authentik state unknown:", err?.message ?? err);
        res.status(502).json({ error: "Could not confirm the change in Authentik; nothing was changed here, try again", code: "IDP_STATE_UNKNOWN", ...removedNote() });
        return;
      }
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { email: newEmail } });
        if (identity) await tx.identity.update({ where: { id: identity.id }, data: { email: newEmail } });
      });
    } catch (err) {
      // Put Authentik back, so the two systems never disagree about who this is.
      if (idp) {
        await updateIdentity(idp.pk, { email: idp.email, username: idp.username }).catch((e) =>
          console.error("Admin email: Authentik rollback failed:", e?.message ?? e),
        );
      }
      throw err;
    }

    const before = { email: user.email };
    const after = { email: newEmail };
    void writeAudit({
      tenantId, actorType: "user", actorId: actorOf(req),
      action: AuditAction.ADMIN_EMAIL_CHANGED, targetType: "user", targetId: user.id,
      metadata: { before, after, reason: req.body.reason, idpUpdated: !!idp, ...(googleRemoved ? { googleDisconnected: true } : {}) },
    });

    res.json({
      data: {
        before,
        after,
        planAccess: await planAccessView(tenantId),
        warnings: [...(idp ? [] : ["no_idp_identity"]), ...(googleRemoved ? ["google_connection_removed"] : [])],
      },
    });
  } catch (err) {
    console.error("Change admin email error:", err);
    res.status(500).json({ error: "Failed to change the email" });
  }
});

// ─── Plan, end date, POC, credits (no charge) ────────────────

const isoDate = z.string().datetime();

const billingManualSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("change_plan"),
    planVersionId: z.string().min(1),
    chatVolumeOptionKey: z.string().min(1).nullable().optional(),
    voiceVolumeOptionKey: z.string().min(1).nullable().optional(),
    // Optional: a live period's end is kept when none is given.
    endsAt: isoDate.optional(),
    reason,
  }).strict(),
  z.object({ action: z.literal("set_end_date"), endsAt: isoDate, reason }).strict(),
  z.object({
    action: z.literal("switch_to_poc"),
    pocCredits: z.number().int().positive().max(1_000_000),
    pocExpiresAt: isoDate,
    pocFeatureAreas: z.array(z.string().min(1)).min(1),
    reason,
  }).strict(),
  z.object({ action: z.literal("add_credits"), units: z.number().int().positive().max(1_000_000), reason }).strict(),
]);

/**
 * The commercial half of a manual edit. Billing owns every rule - it refuses
 * Shopify-billed tenants, dunning, past dates, and leaves renewal off - and
 * answers with what changed; this route adds the actor, audits and reports.
 */
router.post("/tenants/:id/billing/manual", authenticate, requireSystemAdmin(), validate(billingManualSchema), async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.params.id as string;
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found", code: "TENANT_NOT_FOUND" });
      return;
    }

    let status = 0;
    let body: any = {};
    try {
      const r = await fetch(`${BILLING_SERVICE_URL}/api/internal/billing/manual-edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": getInternalServiceKey() },
        body: JSON.stringify({ ...req.body, tenantId, actor: actorOf(req) ?? null }),
        signal: AbortSignal.timeout(30_000),
      });
      status = r.status;
      body = await r.json().catch(() => ({}));
    } catch (err: any) {
      res.status(502).json({ error: "Billing is unreachable; nothing was changed", code: "BILLING_UNREACHABLE" });
      return;
    }

    if (status === 409 || status === 400) {
      // Upper-cased so every console code reads the same way (LAST_ADMIN,
      // EMAIL_TAKEN, SHOPIFY_BILLED, END_DATE_IN_PAST...).
      res.status(409).json({ error: "Refused by billing", code: String(body?.error ?? "refused").toUpperCase(), detail: body?.detail ?? null });
      return;
    }
    if (status < 200 || status >= 300) {
      res.status(502).json({ error: "Billing could not apply the edit", code: body?.error ?? `billing_${status}` });
      return;
    }

    const { ok: _ok, ...result } = body;
    const { reason: why, ...request } = req.body as Record<string, unknown>;
    void writeAudit({
      tenantId, actorType: "user", actorId: actorOf(req),
      action: AuditAction.BILLING_MANUAL_EDIT, targetType: "tenant", targetId: tenantId,
      metadata: {
        action: request.action,
        request,
        before: result.before ?? null,
        after: result.after ?? null,
        ...(result.balanceBefore !== undefined ? { balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter } : {}),
        pendingChangeCleared: result.pendingChangeCleared ?? null,
        renewal: result.renewal,
        charges: result.charges,
        reason: why,
      },
    });

    res.json({ data: { ...result, planAccess: await planAccessView(tenantId), warnings: result.warnings ?? [] } });
  } catch (err) {
    console.error("Manual billing edit error:", err);
    res.status(500).json({ error: "Failed to apply the edit" });
  }
});

export default router;
