/**
 * Payment methods. The card is tokenized on the provider's hosted page
 * (iCount PayPage); the client posts the resulting page token here and we
 * confirm it server-side and store ONLY the token + card metadata. Raw PAN
 * never touches GOTCHA.
 *
 * Storing a card is NOT a purchase and provisions nothing on its own.
 */
import { Router } from "express";
import { authenticate, resolveTenant, requirePermission, prisma } from "@chatcenter/shared";
import { ensureBillableEntity } from "../services/billable-entity.service";
import { defaultProvider } from "../providers";
import { encryptPaymentToken, assertPaymentTokenKey } from "@chatcenter/shared";

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
    // The reusable token is a bearer instrument: encrypted at rest with the
    // dedicated billing key, and the key version stored alongside so rotation
    // does not orphan the row. Validated HERE rather than at startup, so a mock
    // stack that never stores a token needs no key.
    assertPaymentTokenKey();
    const sealed = encryptPaymentToken(tok.token);
    const pm = await prisma.paymentMethod.create({
      data: { billingProfileId: profile.id, provider: provider.name, token: sealed.ciphertext, tokenKeyVersion: sealed.keyVersion, brand: tok.brand, last4: tok.last4, expMonth: tok.expMonth, expYear: tok.expYear, isDefault: true, status: "ACTIVE" },
    });

    // Storing a card provisions NOTHING. It used to auto-start a trial on the
    // BILLING_DEFAULT_TRIAL_PLAN, which handed the customer a subscription they
    // never chose - on a plan key that defaulted to the RETIRED, ILS-priced
    // "pro". A subscription now begins only from an explicit plan selection
    // whose payment has been verified server-side.
    return res.json({ ok: true, paymentMethod: { id: pm.id, brand: pm.brand, last4: pm.last4, expMonth: pm.expMonth, expYear: pm.expYear } });
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
