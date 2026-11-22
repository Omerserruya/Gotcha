/**
 * Per-merchant Shopify custom apps (2026-11-22, Omer, path A): the merchant's request and the console.
 * The record and the platform switch: packages/shared lib/shopify-custom-app.ts.
 *
 * Merchant (the connect permission): GET/POST /connectors/shopify/custom-app/request.
 * Console (system admin): GET /system/shopify-custom-apps, POST .../:tenantId/link | new-link | revoke | grant,
 * GET/PUT /system/shopify-private-apps.
 *
 * Emails go through auth (it holds the mailer): the internal notice on a request, the install link to the
 * merchant on link and new-link. An email that fails never undoes the step; the answer says emailed false.
 */
import { Router, type Request, type Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant,
  requirePermission,
  requireSystemAdmin,
  normalizeShopifyShopDomain,
  getInternalServiceKey,
  readCustomAppRecord,
  writeCustomAppRecord,
  publicCustomAppRecord,
  listCustomAppRecords,
  readPrivateAppsSettings,
  writePrivateAppsSettings,
  sealClientSecret,
  validInstallLink,
  INSTALL_LINK_TTL_MS,
  prisma,
  withCrossTenantAccess,
  type CustomAppRecord,
} from "@chatcenter/shared";
import { currentStoreOf, findShopOwner, shopHeldElsewhere } from "../services/shopify-connection-link.service";
import { grantCustomAppEntitlements, revokeCustomAppEntitlements } from "../services/shopify-custom-app-billing.service";

const router = Router();

const canConnectSystems = requirePermission("integrations:connections:connect", "business-systems:connections:connect");

/** Through auth's internal route. Never throws; true when auth accepted it. */
export async function sendCustomAppEmail(body: Record<string, unknown>): Promise<boolean> {
  const base = (process.env.AUTH_SERVICE_URL || "http://auth:4001").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/internal/auth/shopify-custom-app-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": getInternalServiceKey() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch (err) {
    console.warn("[shopify-custom-app] email not sent:", (err as Error)?.message);
    return false;
  }
}

const linkUsable = (r: CustomAppRecord | null, now = Date.now()) =>
  !!r && r.status === "link_sent" && !!r.installLink && (!r.linkExpiresAt || Date.parse(r.linkExpiresAt) > now);

// ─── Merchant ─────────────────────────────────────────────────

router.get("/connectors/shopify/custom-app/request", authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems, async (req: Request, res: Response) => {
  const record = await readCustomAppRecord(req.tenantId!);
  const settings = await readPrivateAppsSettings();
  const pub = publicCustomAppRecord(record);
  res.json({
    data: pub
      ? { status: pub.status, shopDomain: pub.shopDomain, requestedAt: pub.requestedAt, linkExpiresAt: pub.linkExpiresAt ?? null, installLink: linkUsable(record) ? pub.installLink : null }
      : null,
    enabled: settings.enabled,
  });
});

router.post("/connectors/shopify/custom-app/request", authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canConnectSystems, async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  if (!(await readPrivateAppsSettings()).enabled) { res.status(403).json({ error: "private_apps_off" }); return; }
  const shop = normalizeShopifyShopDomain(req.body?.shopDomain);
  if (!shop || !shop.endsWith(".myshopify.com")) { res.status(400).json({ error: "invalid_shop_domain" }); return; }
  const current = await currentStoreOf(tenantId).catch(() => null);
  if (current?.status === "CONNECTED") { res.status(409).json({ error: "store_connected", data: { shopDomain: current.shopDomain } }); return; }
  const mine = await readCustomAppRecord(tenantId);
  if (mine && mine.status !== "revoked") { res.status(409).json({ error: "already_requested", data: { shopDomain: mine.shopDomain, status: mine.status } }); return; }
  // One shop, one workspace: another workspace's live request or store for this shop refuses this one.
  const others = (await listCustomAppRecords()).filter((x) => x.tenantId !== tenantId && x.record.shopDomain === shop && x.record.status !== "revoked");
  if (others.length || shopHeldElsewhere(await findShopOwner(shop).catch(() => null), tenantId)) {
    res.status(409).json({ error: "shop_requested_elsewhere" });
    return;
  }
  const record: CustomAppRecord = { status: "requested", shopDomain: shop, requestedAt: new Date().toISOString(), requestedBy: (req as any).user?.userId ?? null };
  await writeCustomAppRecord(tenantId, record, (req as any).user?.userId);
  const emailed = await sendCustomAppEmail({ kind: "request_notice", tenantId, shopDomain: shop, requestedAt: record.requestedAt });
  console.log(`[shopify-custom-app] request tenant=${tenantId} shop=${shop} notice_emailed=${emailed}`);
  res.status(201).json({ data: { status: record.status, shopDomain: shop, requestedAt: record.requestedAt } });
});

// ─── Console ──────────────────────────────────────────────────

const consoleGate = [authenticate, requireSystemAdmin()];

router.get("/system/shopify-custom-apps", ...consoleGate, async (_req: Request, res: Response) => {
  const rows = await listCustomAppRecords();
  const tenants: any[] = rows.length
    ? await withCrossTenantAccess(() => (prisma as any).tenant.findMany({ where: { id: { in: rows.map((r) => r.tenantId) } }, select: { id: true, name: true } })) as any[]
    : [];
  const nameOf = new Map(tenants.map((t) => [t.id, t.name]));
  res.json({
    data: rows
      .map(({ tenantId, record }) => {
        const p = publicCustomAppRecord(record)!;
        return { tenantId, tenantName: nameOf.get(tenantId) ?? null, status: p.status, shopDomain: p.shopDomain, requestedAt: p.requestedAt, clientId: p.clientId ?? null, linkExpiresAt: p.linkExpiresAt ?? null, linkSentAt: p.linkSentAt ?? null, installedAt: p.installedAt ?? null, revokedAt: p.revokedAt ?? null };
      })
      .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt))),
    settings: await readPrivateAppsSettings(),
  });
});

function expiryOf(raw: unknown, now: Date): string {
  const t = typeof raw === "string" ? Date.parse(raw) : NaN;
  return new Date(Number.isFinite(t) && t > now.getTime() ? t : now.getTime() + INSTALL_LINK_TTL_MS).toISOString();
}

router.post("/system/shopify-custom-apps/:tenantId/link", ...consoleGate, async (req: Request, res: Response) => {
  const tenantId = String(req.params.tenantId);
  const record = await readCustomAppRecord(tenantId);
  if (!record || (record.status !== "requested" && record.status !== "link_sent")) { res.status(409).json({ error: "not_waiting_for_a_link" }); return; }
  const clientId = typeof req.body?.clientId === "string" ? req.body.clientId.trim() : "";
  const clientSecret = typeof req.body?.clientSecret === "string" ? req.body.clientSecret.trim() : "";
  const link = validInstallLink(req.body?.installLink);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId)) { res.status(400).json({ error: "invalid_client_id" }); return; }
  if (clientSecret.length < 8 || clientSecret.length > 256) { res.status(400).json({ error: "invalid_client_secret" }); return; }
  if (!link) { res.status(400).json({ error: "invalid_install_link" }); return; }
  // A client id is one store's app: never two workspaces'.
  const taken = (await listCustomAppRecords()).some((x) => x.tenantId !== tenantId && x.record.clientId === clientId && x.record.status !== "revoked");
  if (taken || clientId === (process.env.SHOPIFY_API_KEY || "")) { res.status(409).json({ error: "client_id_in_use" }); return; }
  const now = new Date();
  const next: CustomAppRecord = { ...record, status: "link_sent", clientId, clientSecretEnc: sealClientSecret(clientSecret), installLink: link, linkExpiresAt: expiryOf(req.body?.linkExpiresAt, now), linkSentAt: now.toISOString() };
  await writeCustomAppRecord(tenantId, next, (req as any).user?.userId);
  const emailed = await sendCustomAppEmail({ kind: "install_link", tenantId, userId: record.requestedBy, shopDomain: record.shopDomain, installLink: link, expiresAt: next.linkExpiresAt });
  res.json({ data: { ...publicCustomAppRecord(next), emailed } });
});

router.post("/system/shopify-custom-apps/:tenantId/new-link", ...consoleGate, async (req: Request, res: Response) => {
  const tenantId = String(req.params.tenantId);
  const record = await readCustomAppRecord(tenantId);
  if (!record || record.status !== "link_sent") { res.status(409).json({ error: "no_link_to_replace" }); return; }
  const link = validInstallLink(req.body?.installLink);
  if (!link) { res.status(400).json({ error: "invalid_install_link" }); return; }
  const now = new Date();
  const next: CustomAppRecord = { ...record, installLink: link, linkExpiresAt: expiryOf(req.body?.linkExpiresAt, now), linkSentAt: now.toISOString() };
  await writeCustomAppRecord(tenantId, next, (req as any).user?.userId);
  const emailed = await sendCustomAppEmail({ kind: "install_link", tenantId, userId: record.requestedBy, shopDomain: record.shopDomain, installLink: link, expiresAt: next.linkExpiresAt });
  res.json({ data: { ...publicCustomAppRecord(next), emailed } });
});

router.post("/system/shopify-custom-apps/:tenantId/revoke", ...consoleGate, async (req: Request, res: Response) => {
  const tenantId = String(req.params.tenantId);
  const record = await readCustomAppRecord(tenantId);
  if (!record || record.status === "revoked") { res.status(409).json({ error: "nothing_to_revoke" }); return; }
  const next: CustomAppRecord = { ...record, status: "revoked", clientSecretEnc: null, installLink: null, revokedAt: new Date().toISOString(), revokedReason: "console" };
  await writeCustomAppRecord(tenantId, next, (req as any).user?.userId);
  const revoked = await revokeCustomAppEntitlements(tenantId).catch(() => 0);
  res.json({ data: { ...publicCustomAppRecord(next), entitlementsRevoked: revoked } });
});

router.post("/system/shopify-custom-apps/:tenantId/grant", ...consoleGate, async (req: Request, res: Response) => {
  const tenantId = String(req.params.tenantId);
  const record = await readCustomAppRecord(tenantId);
  if (!record || record.status !== "installed") { res.status(409).json({ error: "not_installed" }); return; }
  const granted = await grantCustomAppEntitlements(tenantId, (req as any).user?.userId ?? "console");
  res.json({ data: { granted } });
});

router.get("/system/shopify-private-apps", ...consoleGate, async (_req: Request, res: Response) => {
  res.json({ data: await readPrivateAppsSettings() });
});

router.put("/system/shopify-private-apps", ...consoleGate, async (req: Request, res: Response) => {
  const enabled = req.body?.enabled === true;
  const entitlement = req.body?.entitlement === "manual" ? "manual" : "included";
  if (!(await writePrivateAppsSettings({ enabled, entitlement }, (req as any).user?.userId))) { res.status(409).json({ error: "no_system_organization" }); return; }
  res.json({ data: { enabled, entitlement } });
});

export default router;
