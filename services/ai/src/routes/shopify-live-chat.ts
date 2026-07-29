/**
 * Shopify Live Chat — MERCHANT admin API.
 *
 * Authenticated, tenant-scoped counterpart to the public storefront
 * surface. Lives in services/ai because everything it does needs the
 * connected Shopify integration (owned here) — channel CRUD, the product
 * picker, the live preview and install diagnostics all resolve through
 * the same adapter the AI employee uses.
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireRole,
  requireFeature,
  requireActiveTenant,
  FEATURES,
  normalizeShopifyLiveChatConfig,
  normalizeShopDomain,
  getRedis,
  BUSINESS_HOURS_KEY,
  parseBusinessHours,
  evaluateBusinessHours,
  defaultShopifyLiveChatConfig,
  isFeatureEnabledForTenant,
  getShopifyChatAppConfig,
  buildThemeEditorDeepLink,
  type ProductSnapshot,
} from "@chatcenter/shared";
import {
  listChannels,
  loadChannel,
  saveChannelConfig,
  loadChannelForConversation,
  isProductMessagingAllowed,
  SHOPIFY_LIVE_CHAT,
} from "../services/shopify-live-chat.service";
import {
  resolveShopifyStore,
  probeProductCapability,
  searchCatalog,
  getProductSnapshots,
} from "../services/shopify-catalog.service";
import { sendProductMessage } from "../services/shopify-commerce-message.service";

const router = Router();

/**
 * The tenant's opening hours, as the storefront sees them.
 *
 * Reading the same configuration here is the point: a diagnostics panel
 * that computed availability from a channel-local schedule would happily
 * report "open" while the widget told shoppers the opposite.
 */
async function tenantAvailability(tenantId: string): Promise<"online" | "offline"> {
  try {
    const cfg = parseBusinessHours(await getRedis().get(BUSINESS_HOURS_KEY(tenantId)));
    return evaluateBusinessHours(cfg).open ? "online" : "offline";
  } catch {
    return "online";
  }
}
router.use(authenticate, resolveTenant, requireActiveTenant());

// Theme Editor deep links are built from the CHAT app's identity, never
// the Core integration's: the App Embed belongs to the Chat app, and
// pointing `activateAppId` at the Core client id opens the editor with
// nothing selected.

// ─── Store ───────────────────────────────────────────────────

router.get(
  "/store",
  requireFeature(FEATURES.SHOPIFY_LIVE_CHAT),
  async (req: Request, res: Response) => {
    try {
      const store = await resolveShopifyStore(req.tenantId!);
      if (!store.ok) {
        res.json({ data: { connected: false, reason: store.reason } });
        return;
      }
      const capability = await probeProductCapability(req.tenantId!);
      res.json({
        data: {
          connected: true,
          shopDomain: store.store.shopDomain,
          currency: store.store.currency,
          productCapability: capability,
        },
      });
    } catch (err) {
      console.error("[shopify-live-chat] store error:", (err as Error)?.message);
      res.status(500).json({ error: "Failed to resolve Shopify store" });
    }
  },
);

// ─── Channels ────────────────────────────────────────────────

router.get(
  "/channels",
  requireFeature(FEATURES.SHOPIFY_LIVE_CHAT),
  async (req: Request, res: Response) => {
    try {
      res.json({ data: await listChannels(req.tenantId!) });
    } catch (err) {
      console.error("[shopify-live-chat] list error:", (err as Error)?.message);
      res.status(500).json({ error: "Failed to list channels" });
    }
  },
);

/**
 * Create the channel.
 *
 * A connected store is mandatory: a Shopify Live Chat channel with no
 * Shopify behind it is a support widget wearing a costume, and every
 * downstream guarantee (product truth, store isolation, cart validation)
 * depends on the binding made right here. The binding is written once and
 * is not patchable afterwards.
 */
router.post(
  "/channels",
  requireRole("ADMIN"),
  requireFeature(FEATURES.SHOPIFY_LIVE_CHAT),
  async (req: Request, res: Response) => {
    try {
      const store = await resolveShopifyStore(req.tenantId!);
      if (!store.ok) {
        res.status(409).json({
          error: "Connect a Shopify store before creating this channel.",
          code: store.reason.toUpperCase(),
        });
        return;
      }

      const existing = await listChannels(req.tenantId!);
      const already = existing.find((c) => c.config.shopDomain === store.store.shopDomain);
      if (already) {
        res.status(409).json({ error: "This store already has a live chat channel.", data: already });
        return;
      }

      const base = defaultShopifyLiveChatConfig();
      base.shopDomain = store.store.shopDomain;
      base.tenantIntegrationId = store.store.tenantIntegrationId;
      const config = normalizeShopifyLiveChatConfig(req.body?.config ?? {}, base);
      // Explicit merchant activation only — creating the channel never
      // silently starts serving a widget on a live storefront.
      config.enabled = false;

      const row = await prisma.channelAccount.create({
        data: {
          tenantId: req.tenantId!,
          channel: SHOPIFY_LIVE_CHAT as any,
          externalId: `sfy_${crypto.randomBytes(16).toString("hex")}`,
          displayName: req.body?.displayName?.toString().slice(0, 80) || `Shopify Live Chat`,
          credentials: {},
          platformMeta: { shopifyLiveChat: config } as any,
          connectionStatus: "DISCONNECTED",
          isActive: false,
          connectedBy: req.user?.userId,
          connectedAt: new Date(),
        },
      });

      const channel = await loadChannel(req.tenantId!, row.id);
      res.status(201).json({ data: channel });
    } catch (err) {
      console.error("[shopify-live-chat] create error:", (err as Error)?.message);
      res.status(500).json({ error: "Failed to create channel" });
    }
  },
);

router.get(
  "/channels/:id",
  requireFeature(FEATURES.SHOPIFY_LIVE_CHAT),
  async (req: Request, res: Response) => {
    const channel = await loadChannel(req.tenantId!, String(req.params.id));
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    res.json({ data: channel });
  },
);

router.put(
  "/channels/:id",
  requireRole("ADMIN"),
  requireFeature(FEATURES.SHOPIFY_LIVE_CHAT),
  async (req: Request, res: Response) => {
    try {
      const channel = await loadChannel(req.tenantId!, String(req.params.id));
      if (!channel) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
      const patch = { ...(req.body?.config ?? {}) };

      // The AI employee and department used to be set here, and had to be
      // tenant-checked so an admin could not point their widget at another
      // workspace's employee by id. Both now come from the Main Playbook
      // graph, which is already tenant-scoped, so there is nothing left
      // here to validate — or to get wrong.

      // No owner gate any more. Every other channel lets a conversation
      // land in the inbox unassigned when the graph declines to route it,
      // and a human picks it up; the storefront now behaves the same.
      const merged = normalizeShopifyLiveChatConfig(patch, channel.config);


      const updated = await saveChannelConfig(channel, patch);
      if (req.body?.displayName) {
        await prisma.channelAccount.update({
          where: { id: channel.id },
          data: { displayName: String(req.body.displayName).slice(0, 80) },
        });
      }
      res.json({ data: await loadChannel(req.tenantId!, channel.id) ?? updated });
    } catch (err) {
      console.error("[shopify-live-chat] update error:", (err as Error)?.message);
      res.status(500).json({ error: "Failed to update channel" });
    }
  },
);

router.delete(
  "/channels/:id",
  requireRole("ADMIN"),
  requireFeature(FEATURES.SHOPIFY_LIVE_CHAT),
  async (req: Request, res: Response) => {
    try {
      const channel = await loadChannel(req.tenantId!, String(req.params.id));
      if (!channel) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
      // Disable first so the storefront stops bootstrapping the instant
      // the merchant clicks, then remove. Conversations cascade with the
      // account, which is why the UI warns before this call.
      await saveChannelConfig(channel, { enabled: false });
      await prisma.channelAccount.delete({ where: { id: channel.id } });
      res.json({ data: { deleted: true } });
    } catch (err) {
      console.error("[shopify-live-chat] delete error:", (err as Error)?.message);
      res.status(500).json({ error: "Failed to delete channel" });
    }
  },
);

// ─── Installation + diagnostics ──────────────────────────────

router.get(
  "/channels/:id/diagnostics",
  requireFeature(FEATURES.SHOPIFY_LIVE_CHAT),
  async (req: Request, res: Response) => {
    try {
      const channel = await loadChannel(req.tenantId!, String(req.params.id));
      if (!channel) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
      const store = await resolveShopifyStore(req.tenantId!);
      const capability = store.ok ? await probeProductCapability(req.tenantId!) : null;
      const productEntitled = await isFeatureEnabledForTenant(
        req.tenantId!,
        FEATURES.SHOPIFY_PRODUCT_MESSAGING,
      );

      const heartbeatAt = channel.config.install.lastHeartbeatAt
        ? new Date(channel.config.install.lastHeartbeatAt)
        : null;
      const heartbeatFresh = !!heartbeatAt && Date.now() - heartbeatAt.getTime() < 7 * 24 * 3600 * 1000;

      // Ordered worst-first: the first true statement is the one the
      // merchant needs to act on, and each carries its own repair step.
      const checks = [
        {
          id: "store_connected",
          ok: store.ok,
          state: store.ok ? "ok" : "blocked",
          title: "Shopify store connected",
          detail: store.ok
            ? `Connected to ${store.store.shopDomain}`
            : "No connected Shopify store for this workspace.",
          fix: store.ok ? null : "Go to Settings → Integrations and connect Shopify.",
        },
        {
          id: "store_binding",
          ok: store.ok && store.store.shopDomain === channel.config.shopDomain,
          state: store.ok && store.store.shopDomain === channel.config.shopDomain ? "ok" : "blocked",
          title: "Channel bound to the connected store",
          detail:
            store.ok && store.store.shopDomain === channel.config.shopDomain
              ? `Bound to ${channel.config.shopDomain}`
              : "This channel was created for a different store than the one currently connected.",
          fix:
            store.ok && store.store.shopDomain === channel.config.shopDomain
              ? null
              : "Reconnect the original store, or delete this channel and create one for the new store.",
        },
        {
          id: "product_capability",
          ok: !!capability?.ok,
          state: capability?.ok ? "ok" : "degraded",
          title: "Product access",
          detail: capability?.ok
            ? "Products, prices and inventory are readable."
            : capability?.detail ?? "Product access could not be verified.",
          fix: capability?.ok
            ? null
            : "Reconnect Shopify to grant the read_products scope. Text chat keeps working meanwhile.",
        },
        {
          id: "product_entitlement",
          ok: productEntitled,
          state: productEntitled ? "ok" : "degraded",
          title: "Product messaging entitlement",
          detail: productEntitled
            ? "Product cards and carousels are included in this plan."
            : "This plan does not include Shopify product messaging.",
          fix: productEntitled ? null : "Contact your administrator to add product messaging.",
        },
        {
          id: "routing",
          // Whether the Main Playbook can actually handle a storefront
          // conversation is a property of the graph, not of this channel.
          // Reporting it here would mean re-implementing the walker, so
          // this states where the answer lives rather than guessing at it.
          ok: true,
          state: "info",
          title: "Conversation routing",
          detail:
            "New chats are routed by the Main Playbook, the same as every other channel.",
          fix: null,
        },
        {
          id: "channel_enabled",
          ok: channel.config.enabled,
          state: channel.config.enabled ? "ok" : "blocked",
          title: "Channel enabled",
          detail: channel.config.enabled ? "The widget is allowed to load." : "The channel is turned off.",
          fix: channel.config.enabled ? null : "Turn the channel on once the App Embed is activated.",
        },
        {
          id: "app_embed",
          ok: heartbeatFresh,
          state: heartbeatFresh ? "ok" : "blocked",
          title: "App Embed activated on the storefront",
          detail: heartbeatAt
            ? heartbeatFresh
              ? `Last seen ${heartbeatAt.toISOString()}`
              : `No storefront activity since ${heartbeatAt.toISOString()}.`
            : "The widget has never reported from the storefront.",
          fix: heartbeatFresh
            ? null
            : "Open the Shopify Theme Editor, enable the GOTCHA Chat app embed, and save.",
        },
        {
          id: "storefront_domains",
          ok: channel.config.install.storefrontDomains.length > 0,
          state: channel.config.install.storefrontDomains.length > 0 ? "ok" : "warning",
          title: "Storefront domain declared",
          detail: channel.config.install.storefrontDomains.length
            ? channel.config.install.storefrontDomains.join(", ")
            : "Only the .myshopify.com domain is allowed. Shoppers usually browse a custom domain.",
          fix: channel.config.install.storefrontDomains.length
            ? null
            : "Add your public storefront domain under Installation.",
        },
      ];

      const blocking = checks.find((c) => c.state === "blocked" && !c.ok) ?? null;
      res.json({
        data: {
          status: blocking ? "blocked" : checks.some((c) => !c.ok) ? "degraded" : "healthy",
          blockingCheck: blocking?.id ?? null,
          // Same tenant business hours the widget and the AI employee use.
          availability: await tenantAvailability(channel.tenantId),
          lastHeartbeatAt: channel.config.install.lastHeartbeatAt,
          themeChanged: false,
          checks,
        },
      });
    } catch (err) {
      console.error("[shopify-live-chat] diagnostics error:", (err as Error)?.message);
      res.status(500).json({ error: "Failed to run diagnostics" });
    }
  },
);

router.get(
  "/channels/:id/install",
  requireFeature(FEATURES.SHOPIFY_LIVE_CHAT),
  async (req: Request, res: Response) => {
    const channel = await loadChannel(req.tenantId!, String(req.params.id));
    if (!channel) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const shop = normalizeShopDomain(channel.config.shopDomain);
    // Shopify's Theme Editor deep link needs the app's client id. When it
    // is not configured we say so plainly instead of handing the merchant
    // a link that silently opens the wrong screen.
    const chatApp = getShopifyChatAppConfig();
    const deepLink = shop
      ? buildThemeEditorDeepLink({
          shopDomain: shop,
          clientId: chatApp.clientId,
          blockHandle: chatApp.blockHandle,
        })
      : null;
    res.json({
      data: {
        publicKey: channel.publicKey,
        shopDomain: shop,
        themeEditorDeepLink: deepLink,
        blockHandle: chatApp.blockHandle,
        steps: [
          "Open your Shopify admin and go to Online Store → Themes.",
          "Click Customize on your live theme.",
          "Open App embeds in the left sidebar.",
          "Turn on GOTCHA Chat.",
          "Click Save, then reload your storefront.",
        ],
      },
    });
  },
);

// ─── Product picker (human agents) ───────────────────────────

router.get(
  "/products",
  requireFeature(FEATURES.SHOPIFY_PRODUCT_MESSAGING),
  async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q ?? "").slice(0, 120);
      const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit ?? "10"), 10) || 10));
      const includeUnpublished = String(req.query.includeUnpublished ?? "") === "true";

      const result = await searchCatalog({
        tenantId: req.tenantId!,
        query: q,
        limit,
        includeUnpublished,
      });
      if (!result.ok) {
        res.status(409).json({ error: "Shopify products are unavailable.", code: result.reason });
        return;
      }
      res.json({
        data: { shopDomain: result.store.shopDomain, currency: result.store.currency, products: result.data },
      });
    } catch (err) {
      console.error("[shopify-live-chat] product search error:", (err as Error)?.message);
      res.status(500).json({ error: "Failed to search products" });
    }
  },
);

/**
 * Send one product or a carousel into a conversation as the human agent.
 *
 * The product references are re-resolved from Shopify here; the browser's
 * copy of the price is never persisted. The conversation is loaded
 * tenant-scoped, and the channel binding decides which store is legal —
 * an agent cannot send another workspace's product.
 */
router.post(
  "/conversations/:conversationId/products",
  requireFeature(FEATURES.SHOPIFY_PRODUCT_MESSAGING),
  async (req: Request, res: Response) => {
    try {
      const found = await loadChannelForConversation(
        req.tenantId!,
        String(req.params.conversationId),
      );
      if (!found) {
        res.status(404).json({ error: "Shopify Live Chat conversation not found" });
        return;
      }
      const { channel, conversation } = found;
      if (!(await isProductMessagingAllowed(req.tenantId!, channel.config))) {
        res.status(403).json({ error: "Product messaging is disabled for this channel." });
        return;
      }

      const refs = Array.isArray(req.body?.products) ? req.body.products : [];
      if (!refs.length) {
        res.status(400).json({ error: "Pick at least one product." });
        return;
      }
      const normalized = refs.slice(0, channel.config.commerce.carouselSize).map((r: any) => ({
        productId: r?.productId ? String(r.productId) : null,
        handle: r?.handle ? String(r.handle) : null,
        variantId: r?.variantId ? String(r.variantId) : null,
        reason: r?.reason ? String(r.reason) : null,
      }));

      const resolved = await getProductSnapshots(req.tenantId!, normalized);
      if (!resolved.ok) {
        res.status(409).json({ error: "Shopify products are unavailable.", code: resolved.reason });
        return;
      }
      const products: ProductSnapshot[] = resolved.data.filter((p) =>
        channel.config.commerce.allowUnpublishedProducts ? true : p.status === "active",
      );
      if (!products.length) {
        res.status(409).json({ error: "None of those products can be sent right now." });
        return;
      }

      const outcome = await sendProductMessage({
        tenantId: req.tenantId!,
        conversationId: conversation.id,
        channelAccountId: channel.id,
        shopDomain: channel.config.shopDomain!,
        products,
        source: "agent",
        senderName: req.user!.email,
        addToCartEnabled: channel.config.commerce.addToCartEnabled,
        leadText: typeof req.body?.text === "string" ? req.body.text.slice(0, 1000) : null,
      });
      if (!outcome.ok) {
        res.status(409).json({ error: outcome.reason });
        return;
      }

      await prisma.auditLog.create({
        data: {
          tenantId: req.tenantId!,
          actorType: "user",
          actorId: req.user!.userId,
          action: "shopify_live_chat.product_message_sent",
          targetType: "conversation",
          targetId: conversation.id,
          metadata: {
            messageId: outcome.messageId,
            productCount: outcome.productCount,
            shopDomain: channel.config.shopDomain,
          },
        },
      }).catch(() => {});

      res.status(201).json({ data: outcome });
    } catch (err) {
      console.error("[shopify-live-chat] send product error:", (err as Error)?.message);
      res.status(500).json({ error: "Failed to send product" });
    }
  },
);

export default router;
