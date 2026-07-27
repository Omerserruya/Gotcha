/**
 * Drive a complete paid checkout over HTTP, exactly as a customer's browser
 * would, and confirm the tenant ends up active with credits granted.
 *
 * Verification only. Cleans up after itself.
 */
import { prisma } from "@chatcenter/shared";
import { proposeRate, approveRate } from "../services/exchange-rate.service";
import { issueContinuationLink } from "../services/continuation-link.service";

const BASE = process.env.VERIFY_BASE_URL || "https://dev.gotcha.co.il";

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  const stamp = `httpverify-${Date.now()}`;
  const draft = await proposeRate({ rate: "3.65", createdBy: `${stamp}-author` });
  const rate = await approveRate({ id: draft.id, approvedBy: `${stamp}-approver` });

  const tenant = await prisma.tenant.create({
    data: { name: "HTTP Verification Ltd", slug: stamp, status: "PENDING_PAYMENT" },
  });
  const entity = await prisma.billableEntity.create({ data: { displayName: "HTTP Verification Ltd" } });
  await prisma.billableEntityTenant.create({ data: { billableEntityId: entity.id, tenantId: tenant.id } });

  const checkout = await prisma.pendingCheckout.create({
    data: {
      reference: `chk_${stamp}`, tenantId: tenant.id,
      planKey: "ai_workforce", planVersion: 1,
      snapshotPrice: 499, snapshotCurrency: "USD", snapshotIncludedCredits: 2000,
      amount: 499, currency: "USD", status: "PENDING",
      expiresAt: new Date(Date.now() + 3600_000),
      idempotencyKey: `checkout:chk_${stamp}`,
    },
  });
  const link = await issueContinuationLink({ checkoutId: checkout.id, tenantId: tenant.id });

  const out: Record<string, unknown> = {};

  const session = await post(`/api/checkout/${checkout.reference}/payment-session`, { token: link.token });
  out.paymentSessionStatus = session.status;
  out.hasRedirect = Boolean((session.body as any)?.data?.redirectUrl);

  // A fresh continuation token per call: a link is single-use by design.
  const l2 = await issueContinuationLink({ checkoutId: checkout.id, tenantId: tenant.id });
  const advance = await post(`/api/checkout/${checkout.reference}/advance`, { token: l2.token });
  out.advanceStatus = advance.status;
  out.advancePhase = (advance.body as any)?.data?.phase;

  const after = await prisma.tenant.findUnique({ where: { id: tenant.id } });
  const sub = await prisma.subscription.findUnique({ where: { billableEntityId: entity.id } });
  const lots = await prisma.aiUnitLot.findMany({ where: { tenantId: tenant.id } });
  const attempt = await prisma.paymentAttempt.findFirst({ where: { checkoutId: checkout.id } });

  out.tenantStatus = after?.status;
  out.subscriptionStatus = sub?.status ?? null;
  out.creditsGranted = lots.reduce((n, l) => n + Number(l.unitsGranted ?? 0), 0);
  out.chargeAmount = attempt?.chargeAmount ? String(attempt.chargeAmount) : null;
  out.chargeCurrency = attempt?.chargeCurrency ?? null;
  out.providerCurrencyId = attempt?.providerCurrencyId ?? null;
  out.attemptState = attempt?.state ?? null;

  console.log(JSON.stringify(out, null, 2));

  // Clean up everything, including the rate, so dev is left with charging off.
  await prisma.paymentContinuationLink.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.subscriptionEvent.deleteMany({ where: { subscription: { billableEntityId: entity.id } } });
  await prisma.subscription.deleteMany({ where: { billableEntityId: entity.id } });
  await prisma.aiUnitLot.deleteMany({ where: { tenantId: tenant.id } }).catch(() => {});
  
  await prisma.paymentAttempt.deleteMany({ where: { checkoutId: checkout.id } });
  await prisma.paymentQuote.deleteMany({ where: { checkoutId: checkout.id } });
  await prisma.tokenizationSession.deleteMany({ where: { tenantId: tenant.id } });
  const profiles = await prisma.billingProfile.findMany({ where: { billableEntityId: entity.id }, select: { id: true } });
  await prisma.paymentMethod.deleteMany({ where: { billingProfileId: { in: profiles.map((p) => p.id) } } });
  await prisma.billingProfile.deleteMany({ where: { billableEntityId: entity.id } });
  await prisma.pendingCheckout.deleteMany({ where: { id: checkout.id } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  await prisma.paymentQuote.deleteMany({ where: { fxRateId: rate.id } });
  await prisma.billingExchangeRate.deleteMany({ where: { id: rate.id } });
  console.log("cleaned up");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
