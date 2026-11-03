import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  prisma,
  incomingMessageQueue,
  withCrossTenantAccess,
  recordHandover,
  publishEvent,
  normalizeWebchatConfig,
  publicWebchatConfig,
  getRedis,
  BUSINESS_HOURS_KEY,
  parseBusinessHours,
  evaluateBusinessHours, readDurableSetting, normalizeStorefrontContext,
  visitorLocaleOf, widgetTextsOf, isWidgetLocale, projectWooCommerce, wooCartLine,
  HANDOFF_TTL_SECONDS, handoffRefKey, handoffConversationKey, newHandoffRef, handoffMessage, plainHandoffMessage, handoffButtonLabel, waMeUrl,
  type HandoffRecord, type WebchatConfig, visitorSenderName, visitorAuthor } from "@chatcenter/shared";
import crypto from "crypto";
import { sanitizeVisitorName, sanitizeUntrusted } from "../services/prompt-sanitizer.service";
import { recordWebchatSeen, hostOf, handoffTarget, mintHandoffRef, connectedWooStore, brandOf } from "../services/website-widget.service";
import { answeringEmployee } from "../services/widget-assignment.service";
import { translateWidgetTexts } from "../services/widget-text-translation.service";
import { executeAdapterTool } from "../services/connectors/integration-framework";
import { listActivePromotions } from "../services/widget-promotions.service";
import { resolveWooCurrency } from "../services/discovery-integration.service";
import { tryEmit } from "../services/notifications-emit";
import { emitInboundMessage } from "@chatcenter/shared/src/lib/notifications/inbound-push";
import { offerCrossSellAfterCart } from "../services/woo-chat-turn.service";

const router = Router();

/**
 * Rate limiters - applied to the public, unauthenticated embedded-chat
 * surface. The widget is loaded by every visitor on the tenant's site,
 * so the keys are (widgetId, ip) for init and (sessionId, ip) for
 * message/messages. We trust the JSON body for widget/session ids since
 * the routes themselves verify them downstream - the limiter just keeps
 * unbounded floods from reaching the verification step or burning OpenAI
 * tokens via the BullMQ enqueue.
 *
 * Caps are conservative for the public internet but never block a normal
 * conversation:
 *
 *   /bootstrap, /texts, /init
 *             - 60 / min / (route, widgetId, ip), and 1200 / min / (route,
 *               widgetId) as the flood guard
 *   /message  - 20 / min / (sessionId, ip)      - burst-tolerant, denies floods
 *   /messages - 60 / min / (sessionId, ip)      - polling endpoint
 *
 * The init cap was 5 / min / (widgetId, ip), shared by all three routes
 * (2026-10-25). Every page view bootstraps, so one office testing on three
 * devices, or shoppers behind one carrier NAT, used it up in seconds: 28 of
 * 46 bootstraps on the dev Woo store answered 429 and the widget did not
 * draw. A 429 carries `retryAfter` (seconds) in its body, because a
 * cross-origin script cannot read the Retry-After header.
 *
 * Overrides via env: AI_WIDGET_INIT_RPM / AI_WIDGET_INIT_WIDGET_RPM /
 * AI_WIDGET_MESSAGE_RPM / AI_WIDGET_POLL_RPM.
 */
function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The 429 body, with the wait the widget should honour before retrying. */
function limitedHandler(error: string) {
  return (req: Request, res: Response) => {
    const reset = (req as any).rateLimit?.resetTime as Date | undefined;
    const retryAfter = reset ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000)) : 60;
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error, retryAfter });
  };
}

const initPerVisitor = rateLimit({
  windowMs: 60 * 1000,
  max: envInt("AI_WIDGET_INIT_RPM", 60),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const wid = String((req.body as any)?.widgetId ?? "");
    return `init:${req.path}:${wid}:${req.ip}`;
  },
  handler: limitedHandler("Too many initialisation attempts. Please slow down."),
});

const initPerWidget = rateLimit({
  windowMs: 60 * 1000,
  max: envInt("AI_WIDGET_INIT_WIDGET_RPM", 1200),
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => `initw:${req.path}:${String((req.body as any)?.widgetId ?? "")}`,
  handler: limitedHandler("Too many initialisation attempts. Please slow down."),
});

// Per visitor first: a request one address is refused never counts toward
// the widget's shared cap, so a single flooding address cannot spend it.
const initLimiter = [initPerVisitor, initPerWidget];

const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: envInt("AI_WIDGET_MESSAGE_RPM", 20),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const sid = String((req.body as any)?.sessionId ?? "");
    return `msg:${sid}:${req.ip}`;
  },
  message: { error: "Too many messages. Please slow down." },
});

const pollLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: envInt("AI_WIDGET_POLL_RPM", 60),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const sid = String(req.params.sessionId ?? "");
    return `poll:${sid}:${req.ip}`;
  },
  message: { error: "Too many polls. Please slow down." },
});

/**
 * Hard caps applied before anything else - defends against 100KB
 * customer messages that would balloon the prompt + bill OpenAI.
 */
const MAX_BODY_LENGTH = envInt("AI_WIDGET_MAX_BODY_CHARS", 4000);
const MAX_VISITOR_NAME = 32;
const MAX_PAGE_URL = 512;

// POST /api/embedded-chat/init - Initialize a chat session (public, no auth)
/**
 * POST /bootstrap - everything the widget needs before it draws anything.
 *
 * This exists so a widget that no longer belongs to anyone draws NOTHING.
 * Previously the script painted its launcher unconditionally and only
 * called the server when a visitor opened it; delete the channel and the
 * customer's site kept a chat button that opened onto silence. Asking
 * first means a deleted widget simply is not there.
 *
 * The refusal is uniform on purpose. A deleted widget, a disabled one and
 * an id that never existed all answer the same way: a public endpoint on
 * someone else's website is not a place to explain our internal state.
 *
 * And it answers 200 with an empty body rather than 404. "Render nothing"
 * is a legitimate answer to "what should I render", not a failure - and a
 * 404 puts a red line in the console of a tenant's own website that no
 * amount of handling in the script can suppress. It also stops the status
 * code from confirming whether a given widget id exists.
 */
router.post("/bootstrap", initLimiter, async (req: Request, res: Response) => {
  try {
    const widgetId = String((req.body as any)?.widgetId ?? "").trim();
    if (!widgetId || widgetId.length > 128) {
      res.json({ data: {} });
      return;
    }

    // Public and anonymous: the caller has no tenant context, and the
    // widget id is globally unique by design, so this lookup must be
    // cross-tenant. Everything after it is scoped to the row we found.
    const account = await withCrossTenantAccess(async () =>
      prisma.channelAccount.findFirst({
        where: {
          externalId: widgetId,
          channel: "WEBCHAT",
          connectionStatus: { in: ["CONNECTED", "PENDING"] },
        },
      }),
    );

    if (!account) {
      res.json({ data: {} });
      return;
    }

    // The first real load IS the installation verification.
    if (account.connectionStatus === "PENDING") {
      await withCrossTenantAccess(async () =>
        prisma.channelAccount.update({
          where: { id: account.id },
          data: { connectionStatus: "CONNECTED", connectedAt: new Date(), lastError: null },
        }),
      ).catch(() => undefined);
    }

    // Last seen + host for Install (throttled to hourly inside).
    void withCrossTenantAccess(async () =>
      recordWebchatSeen(account.id, hostOf(req.headers.origin, req.headers.referer)),
    ).catch(() => undefined);

    const config = normalizeWebchatConfig(account.credentials);

    // The tenant's own opening hours - the same ones the AI employee and
    // the storefront widget read. One business, one schedule.
    let offline = false;
    try {
      const hours = parseBusinessHours(await readDurableSetting(account.tenantId, "businessHours"));
      offline = !evaluateBusinessHours(hours).open;
    } catch {
      // Config store unreachable → answer as open. A widget that says
      // "we are closed" because Redis blinked is worse than one that
      // answers out of hours.
      offline = false;
    }

    const widget = await withHandoff(account.tenantId, config, offline);
    // The WhatsApp kind whose number cannot take the conversation: there is
    // nothing to draw (the same uniform "render nothing" as above).
    if (!widget) {
      res.json({ data: {} });
      return;
    }
    res.json({
      data: {
        availability: offline ? "offline" : "online",
        widget,
      },
    });
  } catch (err) {
    console.error("Embedded chat bootstrap error:", (err as Error)?.message);
    res.status(500).json({ error: "unavailable" });
  }
});

/**
 * The visitor's proof that a web chat conversation is theirs: the session
 * token /init returned (the conversation's customerExternalId, random). Every
 * read and write after /init must present it; a conversation id alone (it
 * shows up in URLs and logs) is never enough, and only a WEBCHAT conversation
 * qualifies. Anything else is a plain 404: no hint that the id exists.
 */
/**
 * The public config plus "Continue on WhatsApp": the button shows only when
 * the merchant turned it on AND its number can take it (connected, phone
 * known). The number itself never reaches the page.
 */
/**
 * The language the widget opens in (2026-10-25): the merchant's choice, else
 * the business's own (Tenant.defaultLocale), never the page's. A theme left at
 * lang="en-US" opened a Hebrew shop's widget in English. The customer's first
 * message still switches it to the language they wrote in (W10).
 */
async function openingLanguage(tenantId: string, config: WebchatConfig): Promise<"he" | "en"> {
  const chosen = config.appearance.language;
  if (chosen === "he" || chosen === "en") return chosen;
  const tenant = await withCrossTenantAccess(async () =>
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { defaultLocale: true } }),
  ).catch(() => null);
  return /^he/i.test(String(tenant?.defaultLocale ?? "")) ? "he" : "en";
}

async function withHandoff(tenantId: string, config: WebchatConfig, offline = false) {
  // Products and promotions only while the store they come from is connected (W9).
  const wantsStore = config.commerce.productMessagingEnabled || config.commerce.promotions.couponIds.length > 0;
  const storeConnected = wantsStore
    ? !!(await withCrossTenantAccess(() => connectedWooStore(tenantId)).catch(() => null))
    : false;
  const base = publicWebchatConfig(config, { offline, storeConnected });
  // The coupons the merchant chose, live right now (W9 phase d). None chosen, none shown.
  const promotions = storeConnected && config.commerce.promotions.couponIds.length
    ? await withCrossTenantAccess(() => listActivePromotions(tenantId, config.commerce.promotions.couponIds)).catch(() => [])
    : [];
  // A fixed-amount coupon needs the store's currency to read "₪20 off":
  // the store's own (cached on the connection), never guessed. Null if unknown.
  const promotionCurrency = promotions.length
    ? (await withCrossTenantAccess(() => resolveWooCurrency(tenantId)).catch(() => ({ currency: undefined }))).currency ?? null
    : null;
  const target = await withCrossTenantAccess(() => handoffTarget(tenantId, config.ux)).catch(() => null);
  const lang = await openingLanguage(tenantId, config);
  if (config.ux.kind === "whatsapp" && !target) return null;
  // The business's wordmark on the bubble and pop-up (design 7).
  const brand = await withCrossTenantAccess(() => brandOf(tenantId)).catch(() => null);
  // The header's name (nameSource "employee"): the employee the automation
  // routes this web chat to, so changing who answers changes the name. When
  // the route names no one (conditions, a team), the typed name stays.
  const employeeName = config.nameSource === "employee"
    ? (await withCrossTenantAccess(() => answeringEmployee(tenantId, "WEBCHAT")).catch(() => null))?.employee?.name?.trim() || null
    : null;
  const assistantName = employeeName ?? base.welcome.assistantName;
  return {
    ...base,
    appearance: { ...base.appearance, language: lang },
    welcome: { ...base.welcome, assistantName },
    ux: { ...base.ux, welcome: { ...base.ux.welcome, assistantName } },
    nameSource: employeeName ? "employee" : "custom",
    brand,
    promotions: promotions.map(({ id: _id, ...p }) => ({ ...p, currency: promotionCurrency })),
    features: { ...base.features, whatsappHandoff: !!target },
    ...(target ? { whatsapp: { label: handoffButtonLabel(lang) } } : {}),
  };
}

async function visitorConversation(conversationId: string, token: unknown) {
  if (typeof token !== "string" || !token || !conversationId) return null;
  const c = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true, tenantId: true, channel: true, channelAccountId: true, customerExternalId: true, customerName: true,
      // Who owns it, for message.inbound (a customer message written here
      // rather than by the incoming worker).
      assignedAgentId: true, handledBy: true, isHandedOver: true, departmentId: true, isTest: true, origin: true,
    },
  });
  if (!c || c.channel !== "WEBCHAT" || !c.customerExternalId) return null;
  const a = Buffer.from(String(c.customerExternalId));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? c : null;
}

/**
 * POST /handoff { sessionId, sessionToken } -> { handedOver: true }
 * The widget's "talk to a person" button (2026-10-26). It had no route here:
 * the site adapter answered it locally with an empty success, so the visitor
 * saw "handed over" and nobody was told. Mirrors Shopify Live Chat's POST
 * /handoff, and also tells the team (conversation.escalated), which a waiting
 * conversation alone does not. 403 unless the merchant turned the button on
 * (opt-in: unset is off); 404 on a wrong session. The employee's own
 * escalate_to_human is a different path.
 */
router.post("/handoff", messageLimiter, async (req: Request, res: Response) => {
  try {
    const conv = await withCrossTenantAccess(() => visitorConversation(String(req.body?.sessionId ?? ""), req.body?.sessionToken));
    if (!conv || !conv.channelAccountId) { res.status(404).json({ error: "unavailable" }); return; }
    const account = await withCrossTenantAccess(() => prisma.channelAccount.findFirst({
      where: { id: conv.channelAccountId!, tenantId: conv.tenantId, channel: "WEBCHAT" },
      select: { credentials: true },
    }));
    if (!account) { res.status(404).json({ error: "unavailable" }); return; }
    if (!normalizeWebchatConfig(account.credentials).behaviour.allowHumanHandoff) {
      res.status(403).json({ error: "handoff_disabled" });
      return;
    }
    await recordHandover({
      tenantId: conv.tenantId,
      conversationId: conv.id,
      to: "human",
      reason: "takeover",
      data: { isHandedOver: true, status: "WAITING" },
    });
    const marker = await withCrossTenantAccess(() => prisma.message.create({
      data: {
        tenantId: conv.tenantId,
        conversationId: conv.id,
        channel: "WEBCHAT" as any,
        direction: "INBOUND",
        body: "",
        messageType: "system",
        senderName: "System",
        status: "DELIVERED",
        metadata: { systemEvent: "visitor_requested_human" },
      },
    }));
    // The inbox sorts by lastMessageAt (the same reason as Shopify's route).
    await withCrossTenantAccess(() => prisma.conversation.updateMany({
      where: { id: conv.id, tenantId: conv.tenantId },
      data: { lastMessageAt: marker.createdAt },
    }));
    await publishEvent({
      event: "conversation:updated",
      tenantId: conv.tenantId,
      data: { id: conv.id, isHandedOver: true, status: "WAITING", channel: "WEBCHAT" },
    });
    tryEmit({
      type: "conversation.escalated",
      tenantId: conv.tenantId,
      data: { reason: "The visitor pressed \"talk to a person\" in the website chat", priority: "high" },
      metadata: { conversationId: conv.id },
    });
    res.json({ data: { handedOver: true } });
  } catch (err) {
    console.error("[embedded-chat] handoff error:", (err as Error)?.message);
    res.status(500).json({ error: "unavailable" });
  }
});

/**
 * POST /whatsapp-handoff { sessionId, sessionToken, locale?, text? } -> { url, ref }
 * "Continue on WhatsApp": a short code tied to this visitor's conversation,
 * and the wa.me link with the message that carries it. The same conversation
 * gets the same code (a second click does not orphan the first). 404 when the
 * button should not be there (off, number unavailable) or the token is wrong.
 *
 * `text` is the WhatsApp look's "write here and we continue on WhatsApp": the
 * visitor's own words. They are kept in the website chat (the WhatsApp side
 * reads it as context) WITHOUT a website reply, since the answer comes on
 * WhatsApp, and they open WhatsApp pre-filled, followed by the code.
 */
router.post("/whatsapp-handoff", messageLimiter, async (req: Request, res: Response) => {
  try {
    const conv = await withCrossTenantAccess(() => visitorConversation(String(req.body?.sessionId ?? ""), req.body?.sessionToken));
    if (!conv || !conv.channelAccountId) { res.status(404).json({ error: "unavailable" }); return; }
    const account = await withCrossTenantAccess(() => prisma.channelAccount.findFirst({
      where: { id: conv.channelAccountId!, tenantId: conv.tenantId, channel: "WEBCHAT" },
      select: { credentials: true },
    }));
    if (!account) { res.status(404).json({ error: "unavailable" }); return; }
    const config = normalizeWebchatConfig(account.credentials);
    const target = await withCrossTenantAccess(() => handoffTarget(conv.tenantId, config.ux));
    if (!target) { res.status(404).json({ error: "unavailable" }); return; }

    const redis = getRedis();
    // A typed number (no channel behind it): the link only. A code would ask
    // the customer to carry something nobody will ever read.
    let ref: string | null = target.channelAccountId ? await redis.get(handoffConversationKey(conv.id)) : null;
    if (!ref && target.channelAccountId) {
      const record: HandoffRecord = { tenantId: conv.tenantId, conversationId: conv.id, whatsappChannelAccountId: target.channelAccountId, createdAt: new Date().toISOString() };
      for (let i = 0; i < 5 && !ref; i++) {
        const candidate = newHandoffRef((n) => crypto.randomBytes(n));
        if (await redis.set(handoffRefKey(candidate), JSON.stringify(record), "EX", HANDOFF_TTL_SECONDS, "NX")) ref = candidate;
      }
      if (!ref) { res.status(503).json({ error: "try_again" }); return; }
      await redis.set(handoffConversationKey(conv.id), ref, "EX", HANDOFF_TTL_SECONDS);
    }
    const asked = req.body?.locale;
    const locale = asked === "he" || asked === "en" ? asked : await openingLanguage(conv.tenantId, config);
    const text = typeof req.body?.text === "string" ? sanitizeUntrusted(req.body.text, { wrap: false, maxLength: 500 }).trim() : "";
    if (text) {
      // Recorded, not queued: no website answer to a question asked on WhatsApp.
      const written = await withCrossTenantAccess(() => prisma.message.create({
        data: {
          tenantId: conv.tenantId, conversationId: conv.id, channel: "WEBCHAT", direction: "INBOUND",
          body: text, messageType: "text", status: "DELIVERED", senderName: conv.customerName || "Visitor",
          metadata: { source: "whatsapp_handoff" },
        },
      }));
      // Never through the incoming worker, so it announces itself: the
      // assignee's phone, when a person owns this chat (a queue publish,
      // fire-and-forget; the rule lives in shared).
      emitInboundMessage({ tenantId: conv.tenantId, conversation: conv, messageId: written.id, body: text, messageType: "text", channel: "WEBCHAT" });
    }
    const prefilled = ref ? (text ? `${text} (${ref})` : handoffMessage(ref, locale)) : (text || plainHandoffMessage(locale));
    res.json({ data: { url: waMeUrl(target.digits, prefilled), ref } });
  } catch (err) {
    console.error("Embedded chat whatsapp-handoff error:", (err as Error)?.message);
    res.status(500).json({ error: "unavailable" });
  }
});

/**
 * POST /whatsapp-start { widgetId, text?, locale?, context? } -> { url, ref }
 * The WhatsApp kind of widget (no on-site chat): the visitor's message opens
 * wa.me pre-filled to the business number, followed by a code. No website
 * conversation is created; the code carries the page they were on
 * (`context`: pageType, productHandle, path - a lookup key, re-resolved
 * before anything quotes it), and the WhatsApp side reads it as context.
 * 404 unless the widget is the WhatsApp kind and its number can take it.
 */
router.post("/whatsapp-start", messageLimiter, async (req: Request, res: Response) => {
  try {
    const widgetId = String(req.body?.widgetId ?? "").trim();
    if (!widgetId || widgetId.length > 128) { res.status(404).json({ error: "unavailable" }); return; }
    // Public: the widget id is the only identity, as in /bootstrap.
    const account = await withCrossTenantAccess(() => prisma.channelAccount.findFirst({
      where: { externalId: widgetId, channel: "WEBCHAT", connectionStatus: { in: ["CONNECTED", "PENDING"] } },
      select: { tenantId: true, credentials: true },
    }));
    if (!account) { res.status(404).json({ error: "unavailable" }); return; }
    const config = normalizeWebchatConfig(account.credentials);
    if (config.ux.kind !== "whatsapp") { res.status(404).json({ error: "unavailable" }); return; }
    const target = await withCrossTenantAccess(() => handoffTarget(account.tenantId, config.ux));
    if (!target) { res.status(404).json({ error: "unavailable" }); return; }

    const ctx = normalizeStorefrontContext(req.body?.context);
    const record: HandoffRecord = {
      tenantId: account.tenantId,
      conversationId: null,
      // Only minted for a connected number (below); a typed one has no channel.
      whatsappChannelAccountId: target.channelAccountId ?? "",
      createdAt: new Date().toISOString(),
      context: { pageType: ctx.pageType, productHandle: ctx.productHandle, productId: ctx.productId, path: ctx.path },
    };
    // A typed number: the link only, no code (nothing would read it).
    const ref = target.channelAccountId ? await mintHandoffRef(record, (n) => crypto.randomBytes(n)) : null;
    if (target.channelAccountId && !ref) { res.status(503).json({ error: "try_again" }); return; }
    const asked = req.body?.locale;
    const locale = asked === "he" || asked === "en" ? asked : await openingLanguage(account.tenantId, config);
    const text = typeof req.body?.text === "string" ? sanitizeUntrusted(req.body.text, { wrap: false, maxLength: 500 }).trim() : "";
    const prefilled = ref ? (text ? `${text} (${ref})` : handoffMessage(ref, locale)) : (text || plainHandoffMessage(locale));
    res.json({ data: { url: waMeUrl(target.digits, prefilled), ref } });
  } catch (err) {
    console.error("Embedded chat whatsapp-start error:", (err as Error)?.message);
    res.status(500).json({ error: "unavailable" });
  }
});

/**
 * POST /texts { widgetId, locale: "he" | "en" } -> { locale, texts: { key: text } }
 * The merchant's widget texts in the visitor's language (W10): only the ones
 * written in another language, translated once per text and language
 * (cached). Keys: welcome.title, welcome.subtitle,
 * welcome.suggestedQuestions.<i>, launcher.label, proactive.title,
 * proactive.message, proactive.actionLabel, offline.message. An unknown
 * widget answers empty, like /bootstrap.
 */
router.post("/texts", initLimiter, async (req: Request, res: Response) => {
  try {
    const widgetId = String(req.body?.widgetId ?? "").trim();
    const locale = req.body?.locale;
    if (!isWidgetLocale(locale)) { res.status(400).json({ error: "locale must be he or en" }); return; }
    if (!widgetId || widgetId.length > 128) { res.json({ data: { locale, texts: {} } }); return; }
    const account = await withCrossTenantAccess(() => prisma.channelAccount.findFirst({
      where: { externalId: widgetId, channel: "WEBCHAT", connectionStatus: { in: ["CONNECTED", "PENDING"] } },
      select: { tenantId: true, credentials: true },
    }));
    if (!account) { res.json({ data: { locale, texts: {} } }); return; }
    const config = normalizeWebchatConfig(account.credentials);
    const texts = await translateWidgetTexts(account.tenantId, widgetTextsOf(config.ux, config.offline.message), locale);
    res.json({ data: { locale, texts } });
  } catch (err) {
    console.error("Embedded chat texts error:", (err as Error)?.message);
    res.status(500).json({ error: "unavailable" });
  }
});

/**
 * POST /cart/validate { sessionId, sessionToken, productId, variantId?, quantity? }
 *   -> { cartUrl, productId, variantId, quantity }
 * Add to cart from a product card (W9 phase c). The line is checked against
 * the store's own answer (published, for sale, in stock, the variation is
 * this product's), never the browser's word, and answered as the store's own
 * `?add-to-cart=` link: following it adds the line to the visitor's cart on
 * the store. No order is created. Refusals: 404 (session / product),
 * 403 cart_disabled (switch off or store not connected), 422 with the reason.
 */
router.post("/cart/validate", messageLimiter, async (req: Request, res: Response) => {
  try {
    const conv = await withCrossTenantAccess(() => visitorConversation(String(req.body?.sessionId ?? ""), req.body?.sessionToken));
    if (!conv || !conv.channelAccountId) { res.status(404).json({ error: "unavailable" }); return; }
    const account = await withCrossTenantAccess(() => prisma.channelAccount.findFirst({
      where: { id: conv.channelAccountId!, tenantId: conv.tenantId, channel: "WEBCHAT" },
      select: { credentials: true },
    }));
    if (!account) { res.status(404).json({ error: "unavailable" }); return; }
    const config = normalizeWebchatConfig(account.credentials);
    const store = config.commerce.addToCartEnabled
      ? await withCrossTenantAccess(() => connectedWooStore(conv.tenantId)).catch(() => null)
      : null;
    if (!store) { res.status(403).json({ error: "cart_disabled" }); return; }

    const productId = String(req.body?.productId ?? "").trim();
    const variantId = req.body?.variantId == null || req.body.variantId === "" ? null : String(req.body.variantId).trim();
    if (!/^\d{1,12}$/.test(productId) || (variantId !== null && !/^\d{1,12}$/.test(variantId))) {
      res.status(400).json({ error: "productId and variantId are the store's numeric ids" });
      return;
    }
    const got = await withCrossTenantAccess(() => executeAdapterTool({ tenantId: conv.tenantId, toolFunctionName: "woocommerce.get_product", args: { product_id: productId }, accessScope: "internal" }));
    if (!got.ok) { res.status(404).json({ error: "product_not_found" }); return; }
    const product: any = got.result;
    let variation: any = null;
    if (product?.type === "variable" && variantId) {
      const v = await withCrossTenantAccess(() => executeAdapterTool({ tenantId: conv.tenantId, toolFunctionName: "woocommerce.list_product_variations", args: { product_id: productId, per_page: 100 }, accessScope: "internal" }));
      variation = v.ok && Array.isArray(v.result) ? (v.result as any[]).find((x) => String(x?.id) === variantId) ?? null : null;
    }
    const line = wooCartLine({ storeUrl: store.storeUrl, product, variation, variantId, quantity: req.body?.quantity });
    if (!line.ok) { res.status(422).json({ error: line.reason }); return; }
    const { ok: _ok, ...data } = line;
    res.json({ data });
    // The shopper chose this product: the store's add-ons, once (2a ii). After
    // the answer, never in its way.
    withCrossTenantAccess(() => offerCrossSellAfterCart({ tenantId: conv.tenantId, conversationId: conv.id, productId }))
      .then((r) => console.log(`[embedded-chat][cross-sell] add_to_cart anchor=${productId} ${r} conv=${conv.id}`))
      .catch((err) => console.error(`[embedded-chat][cross-sell] failed conv=${conv.id}:`, (err as Error)?.message));
  } catch (err) {
    console.error("Embedded chat cart validate error:", (err as Error)?.message);
    res.status(500).json({ error: "unavailable" });
  }
});

/**
 * A visitor id the client sent, when it is as strong as one /init mints
 * (128 bits: 32+ hex). The widget's own `v_<time><Math.random>` is not.
 */
function strongClientId(v: unknown): string | null {
  return typeof v === "string" && /^(?:visitor_)?[0-9a-f]{32,128}$/i.test(v) ? v : null;
}

router.post("/init", initLimiter, async (req: Request, res: Response) => {
  try {
    // `sessionToken` resumes a visitor's conversation (the token /init gave
    // them); `sessionId` is the older name for the same thing.
    const { widgetId, visitorId, visitorName, pageUrl } = req.body;
    const sessionId = req.body.sessionToken || req.body.sessionId;

    if (!widgetId || typeof widgetId !== "string") {
      res.status(400).json({ error: "widgetId is required" });
      return;
    }

    // Find the channel account for this widget. Widget init is public - the
    // anonymous caller has no tenant context yet, and widgetId is globally
    // unique by design, so this lookup MUST be cross-tenant. We then derive
    // tenantId from the channel account and scope everything downstream to it.
    const channelAccount = await withCrossTenantAccess(
      async () =>
        await prisma.channelAccount.findFirst({
          // PENDING = created in Settings but never seen on a real site yet.
          // The first successful widget init IS the installation verification:
          // we accept it and flip the account to CONNECTED below. ERROR /
          // DISCONNECTED widgets stay rejected.
          where: { externalId: widgetId, channel: "WEBCHAT", connectionStatus: { in: ["CONNECTED", "PENDING"] } },
        }),
    );

    if (!channelAccount) {
      res.status(404).json({ error: "Widget not found or not active" });
      return;
    }

    if (channelAccount.connectionStatus === "PENDING") {
      await withCrossTenantAccess(async () =>
        prisma.channelAccount.update({
          where: { id: channelAccount.id },
          data: { connectionStatus: "CONNECTED", connectedAt: new Date(), lastError: null },
        }),
      ).catch(() => { /* verification flip is best-effort; chat still works */ });
    }

    // Both ids are minted at 128 bits. The token IS the conversation's secret
    // (it was `sess_<ms>_<8 hex>`, 32 random bits), and a visitor id the client
    // chose is kept only when it is as strong as one we mint (2026-10-09).
    const finalVisitorId = strongClientId(visitorId) ?? `visitor_${crypto.randomBytes(16).toString("hex")}`;
    const clientToken = typeof sessionId === "string" && sessionId ? sessionId : null;

    // Find conversation for THIS session first (tab-level isolation)
    // The token is stored as customerExternalId so each tab gets its own conversation.
    // Resume only this widget's own conversation. A token a live visitor already
    // holds resumes whatever its shape.
    let conversation = clientToken
      ? await prisma.conversation.findFirst({
          where: {
            tenantId: channelAccount.tenantId,
            channelAccountId: channelAccount.id,
            channel: "WEBCHAT",
            customerExternalId: clientToken,
            status: { in: ["OPEN", "WAITING"] },
          },
          orderBy: { updatedAt: "desc" },
        })
      : null;

    // If no session-specific conversation, find by visitor (returning user in
    // new tab), on this widget only: it was workspace-wide, so another widget's
    // token sent as a visitor id resumed that widget's conversation.
    if (!conversation) {
      conversation = await prisma.conversation.findFirst({
        where: {
          tenantId: channelAccount.tenantId,
          channelAccountId: channelAccount.id,
          customerExternalId: finalVisitorId,
          channel: "WEBCHAT",
          status: { in: ["OPEN", "WAITING"] },
        },
        orderBy: { updatedAt: "desc" },
      });
    }

    if (!conversation) {
      // Generate a readable visitor name. Anonymous input - sanitize and
      // cap length so this string can never carry prompt-injection into
      // the bot turn that will later quote `conversation.customerName`.
      let displayName = sanitizeVisitorName(visitorName) || "Website Visitor";
      if (!visitorName && pageUrl) {
        try {
          const safePageUrl = sanitizeUntrusted(pageUrl, { wrap: false, maxLength: MAX_PAGE_URL });
          const hostname = new URL(safePageUrl).hostname.replace("www.", "");
          // Hostnames cannot legitimately contain spaces or control chars
          // by this point - but slice as defence in depth.
          displayName = `Visitor from ${hostname.slice(0, MAX_VISITOR_NAME)}`;
        } catch {}
      }

      conversation = await prisma.conversation.create({
        data: {
          tenantId: channelAccount.tenantId,
          channelAccountId: channelAccount.id,
          channel: "WEBCHAT",
          // A new conversation's token is always ours, never the client's choice.
          customerExternalId: `sess_${crypto.randomBytes(16).toString("hex")}`,
          customerName: displayName,
          status: "OPEN",
        },
      });
    }

    res.json({
      data: {
        sessionId: conversation.id,
        visitorId: finalVisitorId,
        // The token for THIS conversation (what it was created or found with).
        sessionToken: conversation.customerExternalId,
        // tenantId used to be returned here. A visitor's browser has no
        // use for it and every reason not to hold it.
      },
    });
  } catch (err) {
    console.error("Embedded chat init error:", (err as Error)?.message);
    res.status(500).json({ error: "Failed to initialize chat" });
  }
});

// POST /api/embedded-chat/message - Send a message (public)
router.post("/message", messageLimiter, async (req: Request, res: Response) => {
  try {
    const { sessionId, visitorId, body, sessionToken } = req.body;

    if (!sessionId || typeof sessionId !== "string" || !body || typeof body !== "string") {
      res.status(400).json({ error: "sessionId and body are required" });
      return;
    }

    // Hard length cap before anything reaches the queue or the model.
    // The sanitizer further normalises (control chars, RTL, role markers).
    if (body.length > MAX_BODY_LENGTH * 4) {
      // Reject extremely oversized payloads outright (>16k chars). Don't
      // even sanitize - refuse to allocate the work.
      res.status(413).json({ error: "Message too large" });
      return;
    }
    const safeBody = sanitizeUntrusted(body, { wrap: false, maxLength: MAX_BODY_LENGTH });
    if (!safeBody.trim()) {
      res.status(400).json({ error: "body is empty after normalisation" });
      return;
    }

    const conversation = await visitorConversation(sessionId, sessionToken);
    if (!conversation) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const externalMessageId = `widget_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    // Enqueue to the incoming message pipeline so webchat goes through
    // the same routing rules, AI agent processing, and department assignment
    // as all other channels (WhatsApp, Instagram, Email, etc.)
    await incomingMessageQueue.add(
      "process",
      {
        tenantId: conversation.tenantId,
        channel: "WEBCHAT",
        channelAccountId: conversation.channelAccountId || "",
        normalizedMessage: {
          externalMessageId,
          senderId: conversation.customerExternalId || visitorId || "visitor",
          senderDisplayName: conversation.customerName || "Visitor",
          timestamp: new Date().toISOString(),
          contentType: "text",
          body: safeBody,
          messageType: "text",
          // The page the visitor wrote from (W9: the product they are looking
          // at on a store's site). Lookup keys only, re-resolved before use.
          ...(req.body?.context ? { metadata: { storefront: normalizeStorefrontContext(req.body.context) } } : {}),
        },
      },
      { attempts: 3, backoff: { type: "exponential", delay: 1000 } }
    );

    // The language the visitor wrote in (null when too short to tell): the
    // widget switches its strings to it and asks POST /texts for the
    // merchant's texts in it (W10).
    res.json({ data: { messageId: externalMessageId, locale: visitorLocaleOf(safeBody) } });
  } catch (err) {
    console.error("Embedded chat message error:", (err as Error)?.message);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// GET /api/embedded-chat/messages/:sessionId - Get messages for a session (public)
router.get("/messages/:sessionId", pollLimiter, async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.params.sessionId ?? "");
    const after = req.query.after as string | undefined;

    const conversation = await visitorConversation(sessionId, req.query.token);
    if (!conversation) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // ⚠ A system row (a handoff divider, an assignment) is the team's, with no
    //   text for a shopper: the widget drew it as an empty bubble of theirs.
    //   The socket relay already skips them; the poll now does too.
    const where: any = { tenantId: conversation.tenantId, conversationId: sessionId, messageType: { not: "system" } };
    if (after) {
      where.createdAt = { gt: new Date(after) };
    }

    const messages = await prisma.message.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: 100,
      select: {
        id: true,
        direction: true,
        body: true,
        senderName: true,
        createdAt: true,
        metadata: true,
      },
    });

    // Product cards (W9): projected for the visitor, only when they are this
    // widget's and the store they came from is still the connected one. The
    // stored metadata itself never leaves.
    const anyCards = messages.some((m) => (m.metadata as any)?.commerce);
    const store = anyCards
      ? await withCrossTenantAccess(() => connectedWooStore(conversation.tenantId)).catch(() => null)
      : null;
    // The people who replied from the inbox, by their own name (the rows carry
    // their email): the widget labels a person's reply and closes its
    // "connecting you" banner on it.
    const emails = [...new Set(messages.map((m) => m.senderName ?? "").filter((s) => s.includes("@")))];
    const staff = emails.length
      ? await prisma.user.findMany({
          where: { tenantId: conversation.tenantId, email: { in: emails } },
          select: { email: true, name: true },
        })
      : [];
    const staffName = new Map(staff.map((u) => [u.email, u.name]));
    res.json({
      data: messages.map(({ metadata, senderName, ...m }) => ({
        ...m,
        // A person's first name only, never their email.
        senderName: visitorSenderName(senderName),
        ...visitorAuthor({ direction: m.direction, senderName }, staffName.get(senderName ?? "")),
        commerce: projectWooCommerce(metadata, { storeUrl: store?.storeUrl ?? null, channelAccountId: conversation.channelAccountId ?? "" }),
      })),
    });
  } catch (err) {
    console.error("Embedded chat messages error:", (err as Error)?.message);
    res.status(500).json({ error: "Failed to get messages" });
  }
});

export default router;
