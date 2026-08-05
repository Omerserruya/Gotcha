import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  prisma,
  incomingMessageQueue,
  withCrossTenantAccess,
  normalizeWebchatConfig,
  publicWebchatConfig,
  getRedis,
  BUSINESS_HOURS_KEY,
  parseBusinessHours,
  evaluateBusinessHours, readDurableSetting } from "@chatcenter/shared";
import crypto from "crypto";
import { sanitizeVisitorName, sanitizeUntrusted } from "../services/prompt-sanitizer.service";

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
 *   /init     - 5 / min / (widgetId, ip)        - usually called once / tab
 *   /message  - 20 / min / (sessionId, ip)      - burst-tolerant, denies floods
 *   /messages - 60 / min / (sessionId, ip)      - polling endpoint
 *
 * Overrides via env: AI_WIDGET_INIT_RPM / AI_WIDGET_MESSAGE_RPM / AI_WIDGET_POLL_RPM.
 */
function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const initLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: envInt("AI_WIDGET_INIT_RPM", 5),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const wid = String((req.body as any)?.widgetId ?? "");
    return `init:${wid}:${req.ip}`;
  },
  message: { error: "Too many initialisation attempts. Please slow down." },
});

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

    res.json({
      data: {
        availability: offline ? "offline" : "online",
        widget: publicWebchatConfig(config, { offline }),
      },
    });
  } catch (err) {
    console.error("Embedded chat bootstrap error:", (err as Error)?.message);
    res.status(500).json({ error: "unavailable" });
  }
});

router.post("/init", initLimiter, async (req: Request, res: Response) => {
  try {
    const { widgetId, visitorId, sessionId, visitorName, pageUrl } = req.body;

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

    const finalVisitorId = visitorId || `visitor_${crypto.randomBytes(8).toString("hex")}`;
    const finalSessionId = sessionId || `sess_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    // Find conversation for THIS session first (tab-level isolation)
    // sessionId is stored as customerExternalId so each tab gets its own conversation
    let conversation = await prisma.conversation.findFirst({
      where: {
        tenantId: channelAccount.tenantId,
        channel: "WEBCHAT",
        customerExternalId: finalSessionId,
        status: { in: ["OPEN", "WAITING"] },
      },
      orderBy: { updatedAt: "desc" },
    });

    // If no session-specific conversation, find by visitor (returning user in new tab)
    if (!conversation) {
      conversation = await prisma.conversation.findFirst({
        where: {
          tenantId: channelAccount.tenantId,
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
          customerExternalId: finalSessionId,
          customerName: displayName,
          status: "OPEN",
        },
      });
    }

    res.json({
      data: {
        sessionId: conversation.id,
        visitorId: finalVisitorId,
        sessionToken: finalSessionId,
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
    const { sessionId, visitorId, body } = req.body;

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

    const conversation = await prisma.conversation.findUnique({
      where: { id: sessionId },
    });

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
        },
      },
      { attempts: 3, backoff: { type: "exponential", delay: 1000 } }
    );

    res.json({ data: { messageId: externalMessageId } });
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

    const conversation = await prisma.conversation.findUnique({
      where: { id: sessionId },
      select: { tenantId: true },
    });
    if (!conversation) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const where: any = { tenantId: conversation.tenantId, conversationId: sessionId };
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
      },
    });

    res.json({ data: messages });
  } catch (err) {
    console.error("Embedded chat messages error:", (err as Error)?.message);
    res.status(500).json({ error: "Failed to get messages" });
  }
});

export default router;
