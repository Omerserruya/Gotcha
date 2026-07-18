/**
 * Payment methods. The card is tokenized on the provider's hosted page
 * (iCount PayPage); the client posts the resulting page token here and we
 * confirm it server-side (incl. iCount's J5 verification) and store ONLY the
 * token + card metadata. Raw PAN never touches GOTCHA.
 */
import { Router } from "express";
import { authenticate, resolveTenant, requirePermission, prisma } from "@chatcenter/shared";
import { ensureBillableEntity } from "../services/billable-entity.service";
import { createTrialSubscription } from "../services/subscription.service";
import { defaultProvider } from "../providers";

const router = Router();

router.get("/billing/payment-methods", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId: req.tenantId! } });
  if (!link) return res.json({ paymentMethods: [] });
  const profile = await prisma.billingProfile.findUnique({ where: { billableEntityId: link.billableEntityId }, include: { paymentMethods: { where: { status: "ACTIVE" } } } });
  res.json({ paymentMethods: profile?.paymentMethods ?? [] });
});

/** Confirm a PayPage tokenization and store the card-on-file (also used to replace). */
router.post("/billing/payment-methods", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  const { pageToken } = req.body ?? {};
  if (!pageToken) return res.status(400).json({ error: "pageToken required" });
  try {
    const provider = defaultProvider();
    const tok = await provider.tokenizeAndVerify({ pageToken, customer: { email: req.user?.email } });

    const entityId = await ensureBillableEntity(req.tenantId!);
    const profile = await prisma.billingProfile.upsert({
      where: { billableEntityId: entityId },
      create: { billableEntityId: entityId, provider: provider.name, providerCustomerId: tok.providerCustomerId, billingEmail: req.user?.email },
      update: { provider: provider.name, providerCustomerId: tok.providerCustomerId ?? undefined },
    });

    // Replace semantics: a tenant has at most ONE active card. RETIRE every
    // prior active method (status→REMOVED, not just demoted) so no orphaned
    // tokens linger and the default is unambiguous.
    await prisma.paymentMethod.updateMany({ where: { billingProfileId: profile.id, status: "ACTIVE" }, data: { status: "REMOVED", isDefault: false } });
    const pm = await prisma.paymentMethod.create({
      data: { billingProfileId: profile.id, provider: provider.name, token: tok.token, brand: tok.brand, last4: tok.last4, expMonth: tok.expMonth, expYear: tok.expYear, isDefault: true, status: "ACTIVE" },
    });

    // First card on file → start the trial now (card-before-trial). Best-effort:
    // a provisioning hiccup must not fail card storage. No-op once a sub exists.
    let trialStarted = false;
    const sub = await prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
    if (!sub) {
      try {
        await createTrialSubscription({ tenantId: req.tenantId!, planKey: process.env.BILLING_DEFAULT_TRIAL_PLAN || "pro", actor: req.user?.userId });
        trialStarted = true;
      } catch (e: any) {
        console.error(`[billing] auto trial-start failed for tenant ${req.tenantId}:`, e?.message ?? e);
      }
    }
    return res.json({ ok: true, trialStarted, paymentMethod: { id: pm.id, brand: pm.brand, last4: pm.last4, expMonth: pm.expMonth, expYear: pm.expYear } });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "tokenize_failed" });
  }
});

router.delete("/billing/payment-methods/:id", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  // Ownership scoping (cross-tenant IDOR guard). PaymentMethod has no tenantId
  // column - it hangs off BillingProfile -> BillableEntity -> tenant - so the
  // Prisma tenant-guard does NOT cover it. Resolve THIS tenant's billing profile
  // and scope the write with updateMany so a payment-method id belonging to
  // another tenant matches zero rows instead of being mutated by raw id.
  const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId: req.tenantId! } });
  if (!link) return res.json({ ok: true });
  const profile = await prisma.billingProfile.findUnique({ where: { billableEntityId: link.billableEntityId }, select: { id: true } });
  if (!profile) return res.json({ ok: true });
  await prisma.paymentMethod.updateMany({
    where: { id: String(req.params.id), billingProfileId: profile.id },
    data: { status: "REMOVED", isDefault: false },
  });
  res.json({ ok: true });
});

export default router;
