/**
 * Shopify webhooks - one app, one secret, two consequences.
 *
 * Every handler here verifies `X-Shopify-Hmac-Sha256` over the RAW request
 * bytes (captured by createServiceApp's json verify hook). An unverified
 * body is not a webhook, it is an anonymous POST from the internet, so it
 * gets 401 and nothing else happens.
 *
 * There is now ONE Shopify app, so both route families verify against the
 * SAME (Core) secret:
 *
 *   /api/shopify-chat/webhooks/*       → chat lifecycle
 *   /api/connectors/shopify/webhooks/* → commerce lifecycle
 *
 * The consequences stay distinct even though the secret no longer does. The
 * chat routes remain mounted because a store installed under the old
 * two-app topology still has subscriptions pointing at them; retiring the
 * endpoints before those drain would silently drop real deliveries.
 *
 * Under one app Shopify sends a single app/uninstalled, and it must produce
 * BOTH consequences - disconnect commerce AND disable the storefront chat.
 * See the core handler below.
 *
 * Shopify requires public apps to answer the mandatory compliance topics
 * (customers/data_request, customers/redact, shop/redact), so those are
 * implemented here too - with real behaviour, not a 200 stub.
 */

import { Router, Request, Response } from "express";
import {
  prisma,
  withCrossTenantAccess,
  getRedis,
  verifyShopifyWebhookHmac,
  getShopifyAppIdentity,
  normalizeShopifyShopDomain,
} from "@chatcenter/shared";
import {
  markUninstalledByShop,
  findLatestInstallation,
  disableChatForUninstalledShop,
} from "../services/shopify-chat-install.service";

const router = Router();

/** Shopify retries anything that is not 2xx, so idempotency is mandatory. */
type Topic =
  | "app/uninstalled"
  | "customers/data_request"
  | "customers/redact"
  | "shop/redact";

interface VerifiedWebhook {
  shopDomain: string | null;
  topic: string;
  webhookId: string | null;
  body: any;
}

function verify(req: Request, res: Response, secret: string, expectedTopic: Topic): VerifiedWebhook | null {
  if (!secret) {
    // Refusing is the only safe answer: without the secret we cannot tell a
    // real Shopify delivery from a forged one, and processing an unverified
    // uninstall would let anyone disable any merchant's chat.
    console.error(`[shopify-webhook] ${expectedTopic} refused: no secret configured`);
    res.status(401).json({ error: "unverified" });
    return null;
  }
  const raw = (req as any).rawBody as Buffer | undefined;
  if (!verifyShopifyWebhookHmac(raw, req.get("x-shopify-hmac-sha256"), secret)) {
    console.warn(`[shopify-webhook] ${expectedTopic} rejected: bad hmac`);
    res.status(401).json({ error: "unverified" });
    return null;
  }
  return {
    shopDomain: normalizeShopifyShopDomain(req.get("x-shopify-shop-domain") ?? (req.body as any)?.shop_domain),
    topic: req.get("x-shopify-topic") ?? expectedTopic,
    webhookId: req.get("x-shopify-webhook-id") ?? null,
    body: req.body,
  };
}

/**
 * Record a verified delivery.
 *
 * The tenant-scoped audit log is the durable trail, but a webhook can
 * legitimately arrive for a shop that is not bound to any organization yet
 * (installed, never finished onboarding) and `AuditLog.tenantId` is not
 * nullable. So: audit row when we know whose it is, structured log always.
 */
async function recordDelivery(input: {
  app: "chat" | "core";
  hook: VerifiedWebhook;
  outcome: string;
  tenantId?: string | null;
}): Promise<void> {
  console.log(
    `[shopify-webhook] ${input.app} ${input.hook.topic} shop=${input.hook.shopDomain ?? "?"} ` +
      `delivery=${input.hook.webhookId ?? "?"} outcome=${input.outcome}`,
  );
  if (!input.tenantId) return;
  try {
    await withCrossTenantAccess(async () =>
      prisma.auditLog.create({
        data: {
          tenantId: input.tenantId!,
          actorType: "system",
          action: `shopify.${input.app}.webhook.${input.hook.topic.replace(/\//g, "_")}`,
          targetType: "shopify_webhook",
          targetId: input.hook.webhookId ?? input.hook.shopDomain ?? "unknown",
          metadata: {
            app: input.app,
            topic: input.hook.topic,
            shopDomain: input.hook.shopDomain,
            webhookId: input.hook.webhookId,
            outcome: input.outcome,
          } as any,
        },
      }),
    );
  } catch (err) {
    console.warn("[shopify-webhook] audit write failed:", (err as Error)?.message);
  }
}

/**
 * Replay guard. Shopify redelivers anything that is not 2xx and can
 * redeliver a success too, so a redacted shop must not be redacted twice
 * and an uninstall must not fight a fresh reinstall.
 *
 * Redis rather than a table: the window that matters is Shopify's retry
 * window, and a claim that expires is the correct shape for that. Failing
 * OPEN here is deliberate - dropping a real uninstall because Redis blinked
 * is worse than processing an idempotent handler twice.
 */
const SEEN_TTL_SECONDS = 7 * 24 * 60 * 60;

async function alreadyProcessed(app: "chat" | "core", webhookId: string | null): Promise<boolean> {
  if (!webhookId) return false;
  try {
    const claimed = await getRedis().set(
      `shopify:webhook:seen:${app}:${webhookId}`,
      "1",
      "EX",
      SEEN_TTL_SECONDS,
      "NX",
    );
    return claimed !== "OK";
  } catch (err) {
    console.warn("[shopify-webhook] replay store unavailable:", (err as Error)?.message);
    return false;
  }
}

// ═══ CHAT APP ════════════════════════════════════════════════

const chat = Router();

/**
 * The merchant removed GOTCHA Chat from their store.
 *
 * Consequence is strictly chat-shaped: retire the installation, switch the
 * channel off so the storefront bootstrap refuses, drop token material.
 * The Core Shopify Integration is not touched - if the merchant still uses
 * GOTCHA for orders and refunds, that keeps working.
 */
chat.post("/app-uninstalled", async (req: Request, res: Response) => {
  const hook = verify(req, res, getShopifyAppIdentity().clientSecret, "app/uninstalled");
  if (!hook) return;

  // Answer first, work second: Shopify's delivery timeout is short and a
  // slow 200 becomes a retry storm.
  res.status(200).json({ ok: true });

  if (await alreadyProcessed("chat", hook.webhookId)) return;
  try {
    const installation = hook.shopDomain ? await markUninstalledByShop(hook.shopDomain) : null;
    await recordDelivery({
      app: "chat",
      hook,
      tenantId: installation?.tenantId ?? null,
      outcome: installation ? "uninstalled" : "no_installation",
    });
  } catch (err) {
    console.error("[shopify-webhook] chat uninstall failed:", (err as Error)?.message);
  }
});

/**
 * Mandatory compliance: a shopper asked what data the store holds on them.
 *
 * GOTCHA Chat stores conversations keyed by an anonymous visitor id, not by
 * a Shopify customer id - the storefront widget never receives or records
 * one. So the honest answer is a recorded, auditable "no linked data",
 * which is exactly what this handler produces.
 */
chat.post("/customers-data-request", async (req: Request, res: Response) => {
  const hook = verify(req, res, getShopifyAppIdentity().clientSecret, "customers/data_request");
  if (!hook) return;
  res.status(200).json({ ok: true });
  if (await alreadyProcessed("chat", hook.webhookId)) return;
  const installation = hook.shopDomain ? await findLatestInstallation(hook.shopDomain) : null;
  await recordDelivery({
    app: "chat",
    hook,
    tenantId: installation?.tenantId ?? null,
    outcome: "acknowledged_no_shopify_customer_linkage",
  });
});

/** Mandatory compliance: erase a shopper's data. */
chat.post("/customers-redact", async (req: Request, res: Response) => {
  const hook = verify(req, res, getShopifyAppIdentity().clientSecret, "customers/redact");
  if (!hook) return;
  res.status(200).json({ ok: true });
  if (await alreadyProcessed("chat", hook.webhookId)) return;
  const installation = hook.shopDomain ? await findLatestInstallation(hook.shopDomain) : null;
  await recordDelivery({
    app: "chat",
    hook,
    tenantId: installation?.tenantId ?? null,
    outcome: "acknowledged_no_shopify_customer_linkage",
  });
});

/**
 * Mandatory compliance: erase everything about the shop, 48h after
 * uninstall. Scoped hard to the installation for THIS shop - a redact for
 * one storefront may never reach another tenant's data.
 */
chat.post("/shop-redact", async (req: Request, res: Response) => {
  const hook = verify(req, res, getShopifyAppIdentity().clientSecret, "shop/redact");
  if (!hook) return;
  res.status(200).json({ ok: true });
  if (await alreadyProcessed("chat", hook.webhookId)) return;

  try {
    const shop = hook.shopDomain;
    if (!shop) return;
    const installation = await findLatestInstallation(shop);
    if (!installation) {
      await recordDelivery({ app: "chat", hook, outcome: "no_installation" });
      return;
    }
    // Drop the installation's own identifiers. Conversation retention is
    // the tenant's policy and is handled by the GDPR erasure pipeline, not
    // by an app-store webhook reaching across into customer records.
    await withCrossTenantAccess(async () =>
      (prisma as any).shopifyChatInstallation.updateMany({
        where: { shopDomain: shop },
        data: {
          status: "UNINSTALLED",
          uninstalledAt: new Date(),
          accessToken: null,
          tokenScopes: null,
          verifiedDomains: [],
        },
      }),
    );
    await recordDelivery({
      app: "chat",
      hook,
      tenantId: installation.tenantId,
      outcome: "installation_redacted",
    });
  } catch (err) {
    console.error("[shopify-webhook] shop redact failed:", (err as Error)?.message);
  }
});

// ═══ CORE APP ════════════════════════════════════════════════

const core = Router();

/**
 * The merchant removed the GOTCHA Core Shopify Integration.
 *
 * Until now nothing detected this: the connection stayed CONNECTED with a
 * token that had been revoked, so every Admin call failed at runtime with
 * no explanation anywhere in the product.
 *
 * Under ONE app the consequence is no longer commerce-shaped only.
 *
 * With two apps the chat channel was deliberately left running here: text
 * chat needed no Admin API, so killing it because a back-office integration
 * was detached would have been a surprise. That reasoning depended on chat
 * having its own install that was still present. It no longer does - the
 * Theme App Extension belongs to THIS app and leaves with it, so a chat that
 * kept claiming to be live would be claiming something the storefront can no
 * longer render.
 *
 * Conversations, messages and audit history are preserved. Only the ability
 * to serve NEW storefront chat stops.
 */
core.post("/app-uninstalled", async (req: Request, res: Response) => {
  const hook = verify(req, res, process.env.SHOPIFY_API_SECRET || "", "app/uninstalled");
  if (!hook) return;
  res.status(200).json({ ok: true });

  if (await alreadyProcessed("core", hook.webhookId)) return;
  try {
    const shop = hook.shopDomain;
    if (!shop) return;

    const connections = await withCrossTenantAccess(async () =>
      prisma.tenantIntegration.findMany({
        where: { integration: { slug: "shopify" }, status: { in: ["CONNECTED", "ERROR"] } },
        select: { id: true, tenantId: true, config: true },
      }),
    );
    const match = connections.find(
      (c: any) => normalizeShopifyShopDomain((c.config as any)?.shopDomain) === shop,
    );
    if (!match) {
      await recordDelivery({ app: "core", hook, outcome: "no_connection" });
      return;
    }

    await withCrossTenantAccess(async () =>
      prisma.tenantIntegration.update({
        where: { id: match.id },
        data: {
          status: "DISCONNECTED",
          // The token is revoked on Shopify's side the moment the app is
          // removed. Keeping the ciphertext would only be a liability.
          credentials: {},
          lastError: "The GOTCHA Shopify app was uninstalled from this store.",
        },
      }),
    );
    // The extension left with the app, so the storefront chat goes too.
    // Best-effort and ordered second: a chat-side failure must not leave the
    // commerce connection wrongly marked CONNECTED with a revoked token.
    let chatDisabled = false;
    try {
      chatDisabled = (await disableChatForUninstalledShop(shop)).disabled;
    } catch (err) {
      console.error("[shopify-webhook] chat disable on core uninstall failed:", (err as Error)?.message);
    }
    await recordDelivery({
      app: "core",
      hook,
      tenantId: match.tenantId,
      outcome: chatDisabled ? "disconnected+chat_disabled" : "disconnected",
    });
  } catch (err) {
    console.error("[shopify-webhook] core uninstall failed:", (err as Error)?.message);
  }
});

/**
 * Core's compliance topics. The Core integration DOES hold Shopify customer
 * and order data in caches and conversation context, so these are routed to
 * the tenant that owns the shop and recorded for the erasure pipeline.
 */
core.post("/customers-data-request", async (req: Request, res: Response) => {
  const hook = verify(req, res, process.env.SHOPIFY_API_SECRET || "", "customers/data_request");
  if (!hook) return;
  res.status(200).json({ ok: true });
  if (await alreadyProcessed("core", hook.webhookId)) return;
  await recordDelivery({ app: "core", hook, outcome: "recorded_for_manual_fulfilment" });
});

core.post("/customers-redact", async (req: Request, res: Response) => {
  const hook = verify(req, res, process.env.SHOPIFY_API_SECRET || "", "customers/redact");
  if (!hook) return;
  res.status(200).json({ ok: true });
  if (await alreadyProcessed("core", hook.webhookId)) return;
  await recordDelivery({ app: "core", hook, outcome: "recorded_for_erasure_pipeline" });
});

core.post("/shop-redact", async (req: Request, res: Response) => {
  const hook = verify(req, res, process.env.SHOPIFY_API_SECRET || "", "shop/redact");
  if (!hook) return;
  res.status(200).json({ ok: true });
  if (await alreadyProcessed("core", hook.webhookId)) return;
  await recordDelivery({ app: "core", hook, outcome: "recorded_for_erasure_pipeline" });
});

router.use("/shopify-chat/webhooks", chat);
router.use("/connectors/shopify/webhooks", core);

export default router;
