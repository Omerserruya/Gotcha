/**
 * Shopify Live Chat — PUBLIC storefront API.
 *
 * Every request here arrives from a shopper's browser on a merchant's
 * storefront. There is no authentication and there never will be: the
 * trust model is
 *
 *   public channel key  +  verified request Origin  +  signed session
 *
 * and nothing else. In particular the browser never names a tenant, and
 * nothing it says about price, stock, identity or store membership is
 * believed — those are re-resolved server-side against Shopify.
 *
 * Failure responses are deliberately uniform. A disabled channel, a
 * lapsed entitlement, a disconnected store and an unknown key all return
 * the same `unavailable` body: the storefront is not a debugging surface
 * and must not leak billing or configuration state.
 */

import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import {
  prisma,
  incomingMessageQueue,
  analyticsQueue,
  publishEvent,
  signVisitorSession,
  verifyVisitorSession,
  newVisitorId,
  normalizeStorefrontContext,
  isOriginAllowed,
  projectVisitorMessage,
  MAX_VISITOR_MESSAGE_CHARS,
  type VisitorSessionPayload,
  type StorefrontContext,
} from "@chatcenter/shared";
import { sanitizeUntrusted } from "../services/prompt-sanitizer.service";
import {
  resolveForBootstrap,
  loadChannel,
  recordHeartbeat,
  type ShopifyLiveChatChannel,
} from "../services/shopify-live-chat.service";
import { validateCartLine } from "../services/shopify-catalog.service";
import {
  findLiveInstallation,
  recordInstallationHeartbeat,
} from "../services/shopify-chat-install.service";

const router = Router();

// ─── Rate limiting ───────────────────────────────────────────
//
// Keys are (channel key | visitor, ip). We read them from the body
// before verification on purpose: the limiter's job is to stop floods
// from ever reaching the verification step, not to authorise anything.

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function limiter(name: string, defaultMax: number, key: (req: Request) => string) {
  return rateLimit({
    windowMs: 60 * 1000,
    max: envInt(`SHOPIFY_CHAT_${name.toUpperCase()}_RPM`, defaultMax),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${name}:${key(req)}:${req.ip}`,
    message: { error: "rate_limited" },
  });
}

const visitorKey = (req: Request) =>
  String((req.body as any)?.sessionToken ?? req.get("x-visitor-token") ?? "").slice(-24);
// Either identifier the storefront can present. Bucketing by shop domain
// matters now that it is the primary key an App Store install sends.
const channelKey = (req: Request) =>
  String((req.body as any)?.publicKey ?? (req.body as any)?.shopDomain ?? "").slice(0, 64);

const bootstrapLimiter = limiter("bootstrap", 20, channelKey);
const conversationLimiter = limiter("conversation", 20, visitorKey);
const messageLimiter = limiter("message", 20, visitorKey);
const pollLimiter = limiter("poll", 60, visitorKey);
const cartLimiter = limiter("cart", 30, visitorKey);
const eventLimiter = limiter("events", 60, visitorKey);

// ─── CORS ────────────────────────────────────────────────────
//
// The storefront lives on the merchant's own domain, so these responses
// are genuinely cross-origin. We echo the request Origin only after the
// channel resolves and the origin is on its allowlist; a denied request
// gets a 403 with NO CORS header, so the browser cannot read the body
// either way. Preflight is answered permissively because it grants
// nothing on its own — the real request still runs the full check.

function allowOrigin(res: Response, origin: string | undefined): void {
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
}

router.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    allowOrigin(res, req.get("origin"));
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Visitor-Token");
    res.setHeader("Access-Control-Max-Age", "600");
    res.status(204).end();
    return;
  }
  next();
});

/**
 * Mirror the storefront heartbeat onto the Chat installation record.
 *
 * Best-effort and fire-and-forget: a merchant whose widget is serving
 * shoppers must never see a page slow down because we were bookkeeping.
 */
async function touchInstallationHeartbeat(shopDomain: string | null | undefined): Promise<void> {
  if (!shopDomain) return;
  const installation = await findLiveInstallation(shopDomain);
  if (installation) await recordInstallationHeartbeat(installation.id);
}

/** One shape for every refusal. Callers get no detail; our logs do. */
function unavailable(res: Response, reason: string): void {
  console.warn(`[shopify-chat] refused: ${reason}`);
  res.status(403).json({ error: "unavailable" });
}

// ─── Session helpers ─────────────────────────────────────────

interface VisitorContext {
  session: VisitorSessionPayload;
  channel: ShopifyLiveChatChannel;
}

/**
 * Resolve a signed visitor session AND re-check that the channel is still
 * servable. A session issued yesterday must not keep working after the
 * merchant disables the widget or the entitlement lapses, so the channel
 * state is re-read on every call rather than baked into the token.
 */
async function requireVisitor(req: Request, res: Response): Promise<VisitorContext | null> {
  const token = (req.body as any)?.sessionToken ?? req.get("x-visitor-token");
  const session = verifyVisitorSession(token);
  if (!session) {
    res.status(401).json({ error: "session_expired" });
    return null;
  }
  const channel = await loadChannel(session.tenantId, session.channelAccountId);
  if (!channel || !channel.config.enabled || channel.connectionStatus !== "CONNECTED") {
    unavailable(res, "session channel no longer servable");
    return null;
  }
  if (channel.config.shopDomain !== session.shopDomain) {
    unavailable(res, "session shop domain no longer matches channel");
    return null;
  }
  const origin = req.get("origin");
  const allowed = [
    ...(channel.config.shopDomain ? [`https://${channel.config.shopDomain}`] : []),
    ...channel.config.install.storefrontDomains.map((d) => `https://${d}`),
  ];
  // Same-origin XHR from a Shopify theme may omit Origin on GET; only
  // enforce when the browser sent one.
  if (origin && !isOriginAllowed(origin, allowed)) {
    unavailable(res, "origin not allowed for session");
    return null;
  }
  allowOrigin(res, origin);
  return { session, channel };
}

// ─── POST /bootstrap ─────────────────────────────────────────

router.post("/bootstrap", bootstrapLimiter, async (req: Request, res: Response) => {
  try {
    const origin = req.get("origin");
    const resolution = await resolveForBootstrap({
      // App Store installs identify themselves by shop domain, which the
      // Theme App Embed already knows. `publicKey` stays accepted for the
      // manual/recovery path.
      shopDomain: (req.body as any)?.shopDomain,
      publicKey: (req.body as any)?.publicKey,
      origin,
    });
    if (!resolution.ok) {
      unavailable(res, resolution.denial);
      return;
    }
    allowOrigin(res, origin);

    const { channel, availability, productMessagingEnabled } = resolution;
    const context = normalizeStorefrontContext((req.body as any)?.context);

    // Installation heartbeat. This is what makes "is the App Embed
    // actually live?" an observed fact rather than the merchant's word.
    recordHeartbeat(channel.id, channel.config, {
      themeId: (req.body as any)?.themeId ?? null,
      path: context.path,
    }).catch((err) => console.warn("[shopify-chat] heartbeat failed:", err?.message));
    // The installation carries its own heartbeat so the onboarding wizard
    // can verify activation without loading the whole channel config.
    touchInstallationHeartbeat(channel.config.shopDomain).catch(() => undefined);

    // Reuse the browser's existing visitor id when it presents a valid
    // session for THIS channel; otherwise mint a new anonymous one.
    const existing = verifyVisitorSession((req.body as any)?.sessionToken);
    const visitorId =
      existing && existing.channelAccountId === channel.id ? existing.visitorId : newVisitorId();

    const sessionToken = signVisitorSession({
      tenantId: channel.tenantId,
      channelAccountId: channel.id,
      visitorId,
      shopDomain: channel.config.shopDomain!,
    });

    res.json({
      data: {
        session: { token: sessionToken },
        availability,
        widget: publicWidgetConfig(channel, availability, productMessagingEnabled),
      },
    });
  } catch (err) {
    console.error("[shopify-chat] bootstrap error:", (err as Error)?.message);
    res.status(500).json({ error: "unavailable" });
  }
});

/**
 * The ONLY channel data a storefront ever receives.
 *
 * Note what is absent: tenant id, channel account id, AI agent id,
 * department id, integration id, Shopify credentials, entitlement state.
 * The public key the widget already has is its whole identity.
 */
function publicWidgetConfig(
  channel: ShopifyLiveChatChannel,
  availability: string,
  productMessagingEnabled: boolean,
) {
  const { appearance, welcome, hours, routing, commerce } = channel.config;
  const offline = availability === "offline";
  return {
    appearance: {
      primaryColor: appearance.primaryColor,
      contrastColor: appearance.contrastColor,
      logoUrl: appearance.logoUrl,
      avatarUrl: appearance.avatarUrl,
      launcherIcon: appearance.launcherIcon,
      launcherPosition: appearance.launcherPosition,
      cornerRadius: appearance.cornerRadius,
      language: appearance.language,
      direction: appearance.direction,
      showPoweredBy: appearance.showPoweredBy,
    },
    welcome: {
      headline: welcome.headline,
      subline: welcome.subline,
      assistantName: welcome.assistantName,
      suggestedQuestions: welcome.suggestedQuestions,
    },
    offline: {
      active: offline,
      message: hours.offlineMessage,
      behavior: hours.offlineBehavior,
      formFields: hours.offlineFormFields,
      consentRequired: channel.config.privacy.requireOfflineConsent,
      consentText: hours.offlineConsentText,
    },
    features: {
      humanHandoff: routing.allowHumanHandoff,
      productMessaging: productMessagingEnabled,
      addToCart: productMessagingEnabled && commerce.addToCartEnabled,
    },
  };
}

// ─── POST /conversation — create or resume ───────────────────

router.post("/conversation", conversationLimiter, async (req: Request, res: Response) => {
  const ctx = await requireVisitor(req, res);
  if (!ctx) return;
  try {
    const { session, channel } = ctx;
    const conversation = await findOrCreateConversation(session, channel);
    const messages = await loadVisibleMessages(session.tenantId, conversation.id, channel);
    res.json({
      data: {
        conversationId: conversation.id,
        status: conversation.status,
        handledBy: conversation.handledBy,
        isHandedOver: conversation.isHandedOver,
        messages,
      },
    });
  } catch (err) {
    console.error("[shopify-chat] conversation error:", (err as Error)?.message);
    res.status(500).json({ error: "unavailable" });
  }
});

/**
 * One conversation per visitor per channel, resumed until it closes.
 *
 * Deliberately keyed on the visitor id rather than a tab session: the
 * customer who refreshes, navigates from the product page to the cart,
 * or comes back an hour later expects the same thread — not a new one
 * with a fresh bot greeting.
 */
async function findOrCreateConversation(
  session: VisitorSessionPayload,
  channel: ShopifyLiveChatChannel,
) {
  const existing = await prisma.conversation.findFirst({
    where: {
      tenantId: session.tenantId,
      channel: "SHOPIFY_LIVE_CHAT" as any,
      customerExternalId: session.visitorId,
      status: { not: "CLOSED" },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  return prisma.conversation.create({
    data: {
      tenantId: session.tenantId,
      channelAccountId: channel.id,
      channel: "SHOPIFY_LIVE_CHAT" as any,
      customerExternalId: session.visitorId,
      customerName: `Shopper on ${channel.config.shopDomain}`,
      status: "OPEN",
      departmentId: channel.config.routing.departmentId,
      assignedAiAgentId: channel.config.routing.aiAgentId,
    },
  });
}

// ─── POST /message ───────────────────────────────────────────

router.post("/message", messageLimiter, async (req: Request, res: Response) => {
  const ctx = await requireVisitor(req, res);
  if (!ctx) return;
  try {
    const { session, channel } = ctx;
    const raw = (req.body as any)?.body;
    if (typeof raw !== "string" || !raw.trim()) {
      res.status(400).json({ error: "empty_message" });
      return;
    }
    // Refuse absurd payloads outright rather than paying to normalise
    // them — an oversized body is a flood, not a question.
    if (raw.length > MAX_VISITOR_MESSAGE_CHARS * 4) {
      res.status(413).json({ error: "message_too_large" });
      return;
    }
    const body = sanitizeUntrusted(raw, { wrap: false, maxLength: MAX_VISITOR_MESSAGE_CHARS });
    if (!body.trim()) {
      res.status(400).json({ error: "empty_message" });
      return;
    }

    const conversation = await findOrCreateConversation(session, channel);
    const context = normalizeStorefrontContext((req.body as any)?.context);

    // Client-supplied id makes the send idempotent: a retry after a flaky
    // network collapses onto the same externalMessageId, which the
    // incoming worker already dedupes on. That is what stops a double-tap
    // (or an offline retry) becoming two questions to the AI employee.
    const clientId = normalizeClientId((req.body as any)?.clientId);
    const externalMessageId = `sfychat_${conversation.id}_${clientId}`;

    await incomingMessageQueue.add(
      "process",
      {
        tenantId: session.tenantId,
        channel: "SHOPIFY_LIVE_CHAT",
        channelAccountId: channel.id,
        normalizedMessage: {
          externalMessageId,
          senderId: session.visitorId,
          senderDisplayName: conversation.customerName ?? "Shopper",
          timestamp: new Date().toISOString(),
          contentType: "text",
          body,
          messageType: "text",
          metadata: { storefront: context },
        },
      },
      { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
    );

    trackEvent(session.tenantId, "shopify_chat_message_sent", {
      conversationId: conversation.id,
      pageType: context.pageType,
    });

    res.json({ data: { accepted: true, conversationId: conversation.id, clientId } });
  } catch (err) {
    console.error("[shopify-chat] message error:", (err as Error)?.message);
    res.status(500).json({ error: "unavailable" });
  }
});

function normalizeClientId(raw: unknown): string {
  if (typeof raw === "string" && /^[A-Za-z0-9_-]{6,48}$/.test(raw)) return raw;
  return crypto.randomBytes(8).toString("hex");
}

// ─── GET /messages — poll / reconnect ────────────────────────

router.get("/messages", pollLimiter, async (req: Request, res: Response) => {
  const ctx = await requireVisitor(req, res);
  if (!ctx) return;
  try {
    const { session, channel } = ctx;
    const conversation = await prisma.conversation.findFirst({
      where: {
        tenantId: session.tenantId,
        channel: "SHOPIFY_LIVE_CHAT" as any,
        customerExternalId: session.visitorId,
        status: { not: "CLOSED" },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!conversation) {
      res.json({ data: { messages: [], conversationId: null } });
      return;
    }
    const after = typeof req.query.after === "string" ? new Date(req.query.after) : null;
    const messages = await loadVisibleMessages(
      session.tenantId,
      conversation.id,
      channel,
      after && !Number.isNaN(after.getTime()) ? after : null,
    );
    res.json({
      data: {
        conversationId: conversation.id,
        status: conversation.status,
        isHandedOver: conversation.isHandedOver,
        messages,
      },
    });
  } catch (err) {
    console.error("[shopify-chat] poll error:", (err as Error)?.message);
    res.status(500).json({ error: "unavailable" });
  }
});

/**
 * Read a page of history and hand every row to the shared visitor
 * projection — the same function the realtime socket path uses, so
 * polling and streaming can never disagree about what is safe to show.
 */
async function loadVisibleMessages(
  tenantId: string,
  conversationId: string,
  channel: ShopifyLiveChatChannel,
  after: Date | null = null,
) {
  const rows = await prisma.message.findMany({
    where: {
      tenantId,
      conversationId,
      ...(after ? { createdAt: { gt: after } } : {}),
      messageType: { not: "system" },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: {
      id: true,
      direction: true,
      body: true,
      messageType: true,
      senderName: true,
      metadata: true,
      mediaUrl: true,
      createdAt: true,
    },
  });

  const projectionContext = {
    assistantName: channel.config.welcome.assistantName,
    shopDomain: channel.config.shopDomain ?? "",
    channelAccountId: channel.id,
  };
  return rows
    .map((m) => projectVisitorMessage(m, projectionContext))
    .filter((m): m is NonNullable<typeof m> => m !== null);
}

// ─── POST /cart/validate ─────────────────────────────────────

router.post("/cart/validate", cartLimiter, async (req: Request, res: Response) => {
  const ctx = await requireVisitor(req, res);
  if (!ctx) return;
  try {
    const { session, channel } = ctx;
    if (!channel.config.commerce.addToCartEnabled) {
      res.status(403).json({ error: "add_to_cart_disabled" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await validateCartLine({
      tenantId: session.tenantId,
      // The shop comes from the CHANNEL, never from the request — this is
      // what makes "add a variant from another store" unrepresentable.
      expectedShopDomain: channel.config.shopDomain!,
      productId: String(body.productId ?? ""),
      variantId: String(body.variantId ?? ""),
      quantity: Number(body.quantity ?? 1),
      allowUnpublished: channel.config.commerce.allowUnpublishedProducts,
    });

    if (!result.ok) {
      trackEvent(session.tenantId, "shopify_chat_add_to_cart_failed", { code: result.code });
      res.status(409).json({ error: result.code, message: result.detail });
      return;
    }

    trackEvent(session.tenantId, "shopify_chat_add_to_cart_validated", {
      variantId: result.variantId,
    });

    // We return a validated variant id and quantity — the storefront
    // bridge performs the actual cart mutation same-origin against the
    // theme's own /cart/add.js. No Admin credential is involved, and no
    // order is ever created from chat.
    res.json({
      data: {
        variantId: result.variantId,
        quantity: result.quantity,
        price: result.price,
        currency: result.currency,
        title: result.title,
        variantTitle: result.variantTitle,
        productUrl: result.productUrl,
      },
    });
  } catch (err) {
    console.error("[shopify-chat] cart validate error:", (err as Error)?.message);
    res.status(500).json({ error: "unavailable" });
  }
});

// ─── POST /cart/result — report the storefront outcome ───────

router.post("/cart/result", cartLimiter, async (req: Request, res: Response) => {
  const ctx = await requireVisitor(req, res);
  if (!ctx) return;
  const ok = (req.body as any)?.ok === true;
  trackEvent(ctx.session.tenantId, ok ? "shopify_chat_add_to_cart_succeeded" : "shopify_chat_add_to_cart_failed", {
    stage: "storefront",
  });
  res.json({ data: { recorded: true } });
});

// ─── POST /handoff — ask for a human ─────────────────────────

router.post("/handoff", conversationLimiter, async (req: Request, res: Response) => {
  const ctx = await requireVisitor(req, res);
  if (!ctx) return;
  try {
    const { session, channel } = ctx;
    if (!channel.config.routing.allowHumanHandoff) {
      res.status(403).json({ error: "handoff_disabled" });
      return;
    }
    const conversation = await findOrCreateConversation(session, channel);
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { isHandedOver: true, status: "WAITING", handledBy: "human" },
    });
    await prisma.message.create({
      data: {
        tenantId: session.tenantId,
        conversationId: conversation.id,
        channel: "SHOPIFY_LIVE_CHAT" as any,
        direction: "INBOUND",
        body: "",
        messageType: "system",
        senderName: "System",
        status: "DELIVERED",
        metadata: { systemEvent: "visitor_requested_human" },
      },
    });
    // Routing and agent notification are the existing platform's job —
    // this event is the same one every other channel raises on handoff.
    await publishEvent({
      event: "conversation:updated",
      tenantId: session.tenantId,
      data: { id: conversation.id, isHandedOver: true, status: "WAITING", channel: "SHOPIFY_LIVE_CHAT" },
    });
    trackEvent(session.tenantId, "shopify_chat_handoff_requested", { conversationId: conversation.id });
    res.json({ data: { handedOver: true } });
  } catch (err) {
    console.error("[shopify-chat] handoff error:", (err as Error)?.message);
    res.status(500).json({ error: "unavailable" });
  }
});

// ─── POST /lead — offline contact form ───────────────────────

router.post("/lead", conversationLimiter, async (req: Request, res: Response) => {
  const ctx = await requireVisitor(req, res);
  if (!ctx) return;
  try {
    const { session, channel } = ctx;
    if (channel.config.hours.offlineBehavior !== "form") {
      res.status(403).json({ error: "lead_form_disabled" });
      return;
    }
    if (channel.config.privacy.requireOfflineConsent && (req.body as any)?.consent !== true) {
      res.status(400).json({ error: "consent_required" });
      return;
    }
    const fields = channel.config.hours.offlineFormFields;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = fields.includes("name") ? clean(body.name, 80) : "";
    const email = fields.includes("email") ? cleanEmail(body.email) : "";
    const note = fields.includes("message") ? clean(body.message, 1000) : "";
    if (!note && !email) {
      res.status(400).json({ error: "nothing_to_submit" });
      return;
    }

    const conversation = await findOrCreateConversation(session, channel);
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        customerName: name || conversation.customerName,
        status: "WAITING",
        isHandedOver: true,
      },
    });
    await prisma.message.create({
      data: {
        tenantId: session.tenantId,
        conversationId: conversation.id,
        channel: "SHOPIFY_LIVE_CHAT" as any,
        direction: "INBOUND",
        body: note || "(no message)",
        messageType: "text",
        senderName: name || "Shopper",
        status: "DELIVERED",
        metadata: { source: "offline_form", email: email || null, consent: true },
      },
    });
    await publishEvent({
      event: "conversation:updated",
      tenantId: session.tenantId,
      data: { id: conversation.id, status: "WAITING", channel: "SHOPIFY_LIVE_CHAT" },
    });
    trackEvent(session.tenantId, "shopify_chat_offline_lead", { conversationId: conversation.id });
    res.json({ data: { submitted: true } });
  } catch (err) {
    console.error("[shopify-chat] lead error:", (err as Error)?.message);
    res.status(500).json({ error: "unavailable" });
  }
});

function clean(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return sanitizeUntrusted(raw, { wrap: false, maxLength: max }).trim();
}

function cleanEmail(raw: unknown): string {
  const v = clean(raw, 160).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : "";
}

// ─── POST /events — widget analytics ─────────────────────────

const ALLOWED_EVENTS = new Set([
  "widget_opened",
  "widget_closed",
  "conversation_started",
  "suggested_question_clicked",
  "product_shown",
  "product_clicked",
  "variant_selected",
  "add_to_cart_attempted",
]);

router.post("/events", eventLimiter, async (req: Request, res: Response) => {
  const ctx = await requireVisitor(req, res);
  if (!ctx) return;
  const raw = (req.body as any)?.events;
  const events = Array.isArray(raw) ? raw.slice(0, 20) : [];
  for (const e of events) {
    const name = typeof e?.name === "string" ? e.name : "";
    if (!ALLOWED_EVENTS.has(name)) continue;
    trackEvent(ctx.session.tenantId, `shopify_chat_${name}`, {
      // Only structural facts are kept. No message text, no cart value,
      // no identifiers beyond the product being looked at.
      pageType: typeof e?.pageType === "string" ? e.pageType.slice(0, 20) : null,
      productId: typeof e?.productId === "string" ? e.productId.slice(0, 32) : null,
    });
  }
  res.json({ data: { recorded: events.length } });
});

/**
 * Analytics ride the existing pipeline. Fire-and-forget on purpose: a
 * Redis hiccup must never break a shopper's chat.
 */
function trackEvent(tenantId: string, event: string, data: Record<string, unknown>): void {
  analyticsQueue
    .add(event, { tenantId, event, data, timestamp: new Date().toISOString() })
    .catch(() => {});
}

export default router;
