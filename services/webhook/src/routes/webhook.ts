import crypto from "crypto";
import { Router, Request, Response } from "express";
import {
  prisma,
  incomingMessageQueue,
  publishEvent,
  detectInboundAdapter,
  gmailInboundAdapter,
  gmailFetchNewMessages,
  outlookInboundAdapter,
  slackInboundAdapter,
  decryptCredentials,
} from "@chatcenter/shared";
import type { NormalizedInboundMessage, NormalizedStatusUpdate } from "@chatcenter/shared";

const router = Router();

// Webhook verification (GET) - shared by WhatsApp and Messenger
router.get("/", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && token === verifyToken) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.status(403).send("Forbidden");
  }
});

// Unified webhook handler (POST) - detects platform via adapter pattern
router.post("/", async (req: Request, res: Response) => {
  // Always respond 200 quickly (required by both WhatsApp and Messenger)
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log(`[WEBHOOK] Incoming: object=${body?.object}, entries=${body?.entry?.length || 0}`, JSON.stringify(body).slice(0, 500));

    // Step 1: Detect which platform sent this webhook
    const adapter = detectInboundAdapter(body);
    if (!adapter) {
      console.warn("Webhook received from unknown platform:", body?.object);
      return;
    }

    // Step 2: Verify signature
    const signatureHeader = adapter.getSignatureHeader();
    const signature = req.headers[signatureHeader] as string;
    if (signature) {
      // Try channel account secret first, fall back to app secret
      const appSecret = process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET;
      const rawBody = (req as any).rawBody;
      if (appSecret && rawBody && !adapter.verifySignature(appSecret, rawBody, signature)) {
        console.error(`Invalid webhook signature for ${adapter.channel}`);
        return;
      }
    }

    // Step 2.5: Template-related updates from WhatsApp arrive at the WABA level
    // (entry.id = WABA id, no phone_number_id), so they cannot be resolved via
    // resolveChannelAccountExternalId. Handle them independently up-front.
    const TEMPLATE_FIELDS = new Set([
      "message_template_status_update",
      "template_category_update",
      "template_correct_category_detection",
      "message_template_components_update",
      "message_template_quality_update",
    ]);
    if (adapter.channel === "WHATSAPP") {
      for (const entry of body.entry || []) {
        const templateChanges = (entry.changes || []).filter((c: any) => TEMPLATE_FIELDS.has(c.field));
        if (templateChanges.length === 0) continue;

        const wabaId = String(entry.id || "");
        if (!wabaId) continue;

        // Find the matching channel account by decrypting credentials (rare event, OK to iterate)
        const candidates = await prisma.channelAccount.findMany({
          where: { channel: "WHATSAPP", isActive: true },
        });
        let matchedAccount: typeof candidates[number] | null = null;
        for (const acc of candidates) {
          try {
            const creds = decryptCredentials(acc.credentials as any);
            if (String(creds?.wabaId || "") === wabaId) {
              matchedAccount = acc;
              break;
            }
          } catch {}
        }
        if (!matchedAccount) {
          console.warn(`[WEBHOOK] No channel account found for WABA ${wabaId} template update`);
          continue;
        }

        const whereTemplate = (name: string) => ({
          tenantId: matchedAccount!.tenantId,
          channel: "WHATSAPP" as const,
          OR: [
            { channelAccountId: matchedAccount!.id, name },
            { channelAccountId: null, name },
          ],
        });

        for (const change of templateChanges) {
          try {
            const tu = change.value || {};
            const metaTemplateName = tu.message_template_name;
            const metaTemplateId = tu.message_template_id ? String(tu.message_template_id) : null;
            if (!metaTemplateName) continue;

            const data: any = {};
            if (metaTemplateId) data.metaTemplateId = metaTemplateId;

            switch (change.field) {
              case "message_template_status_update": {
                const statusMap: Record<string, string> = {
                  APPROVED: "APPROVED",
                  REJECTED: "REJECTED",
                  PENDING_DELETION: "APPROVED",
                  DISABLED: "REJECTED",
                  FLAGGED: "REJECTED",
                };
                const newStatus = statusMap[tu.event];
                if (!newStatus) continue;
                data.status = newStatus;
                if (tu.reason) data.rejectionReason = tu.reason;
                else if (newStatus === "APPROVED") data.rejectionReason = null;
                break;
              }
              case "template_category_update": {
                if (tu.new_category) data.category = String(tu.new_category).toUpperCase();
                break;
              }
              case "template_correct_category_detection": {
                // Meta suggests a different category; we just record it in rejectionReason for visibility
                if (tu.correct_category) {
                  data.rejectionReason = `Meta suggested category: ${tu.correct_category}`;
                }
                break;
              }
              case "message_template_quality_update": {
                // Optional: we don't have a column; skip DB write but log
                console.log(`[WEBHOOK] Template "${metaTemplateName}" quality: ${tu.new_quality_score}`);
                if (Object.keys(data).length === 0) continue;
                break;
              }
              case "message_template_components_update": {
                // Meta edited components on their side; we can't reliably map them back, just log
                console.log(`[WEBHOOK] Template "${metaTemplateName}" components updated on Meta`);
                if (Object.keys(data).length === 0) continue;
                break;
              }
            }

            if (Object.keys(data).length === 0) continue;

            await prisma.messageTemplate.updateMany({
              where: whereTemplate(metaTemplateName),
              data,
            });
            console.log(`[WEBHOOK] Template "${metaTemplateName}" updated via ${change.field}:`, data);
          } catch (tplErr) {
            console.error(`[WEBHOOK] ${change.field} error:`, tplErr);
          }
        }
      }
    }

    // Step 3: Resolve tenant via ChannelAccount
    const channelExternalId = adapter.resolveChannelAccountExternalId(body);
    if (!channelExternalId) {
      // Template-only payloads are already handled in Step 2.5; silent return is fine.
      return;
    }

    const channelAccount = await prisma.channelAccount.findFirst({
      where: { externalId: channelExternalId, channel: adapter.channel, isActive: true },
    });

    if (!channelAccount) {
      console.warn(`No channel account found for ${adapter.channel} account: ${channelExternalId}`);
      return;
    }

    const tenantId = channelAccount.tenantId;
    const channelAccountId = channelAccount.id;

    // Step 4: Extract and enqueue normalized messages
    const messages = adapter.extractMessages(body);
    for (const msg of messages) {
      const { body: msgBody, messageType, mediaUrl } = normalizeContentToBodyAndType(msg);
      await incomingMessageQueue.add(
        "process",
        {
          tenantId,
          channel: adapter.channel,
          channelAccountId,
          normalizedMessage: {
            externalMessageId: msg.externalMessageId,
            senderId: msg.senderId,
            senderDisplayName: msg.senderDisplayName,
            timestamp: msg.timestamp.toISOString(),
            contentType: msg.content.type,
            body: msgBody,
            messageType,
            interactiveReply: msg.content.interactiveReply,
            mediaUrl,
          },
        },
        { attempts: 3, backoff: { type: "exponential", delay: 1000 } }
      );
    }

    // Step 5: Handle status updates inline (lightweight)
    const statusUpdates = adapter.extractStatusUpdates(body);
    for (const status of statusUpdates) {
      await handleStatusUpdate(tenantId, status);
    }

  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

// ─── Helpers ─────────────────────────────────────────────────

function normalizeContentToBodyAndType(msg: NormalizedInboundMessage): { body: string; messageType: string; mediaUrl?: string } {
  const content = msg.content;
  if (content.interactiveReply) {
    return { body: content.interactiveReply.title || content.text || "", messageType: "interactive" };
  }
  switch (content.type) {
    case "text":
      return { body: content.text || "", messageType: "text" };
    case "image":
      return { body: content.caption || "[Image]", messageType: "image", mediaUrl: content.mediaUrl };
    case "document":
      return { body: content.caption || "[Document]", messageType: "document", mediaUrl: content.mediaUrl };
    case "audio":
      return { body: content.text || "[Audio message]", messageType: "audio", mediaUrl: content.mediaUrl };
    case "video":
      return { body: content.caption || "[Video]", messageType: "video", mediaUrl: content.mediaUrl };
    case "location":
      return { body: content.text || "[Location]", messageType: "location" };
    default:
      return { body: content.text || `[${content.type} message]`, messageType: content.type };
  }
}

async function handleStatusUpdate(tenantId: string, status: NormalizedStatusUpdate) {
  const statusMap: Record<string, string> = {
    sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED",
  };
  const mappedStatus = statusMap[status.status];
  if (!mappedStatus) return;

  const message = await prisma.message.findFirst({
    where: { externalMessageId: status.externalMessageId },
  });

  if (message) {
    await prisma.message.update({
      where: { id: message.id },
      data: { status: mappedStatus as any },
    });
    await publishEvent({
      event: "message:status",
      tenantId,
      data: {
        messageId: message.id,
        conversationId: message.conversationId,
        status: mappedStatus,
      },
    });
  }
}

// ─── Email Webhook (POST) ──────────────────────────────────────
router.post("/email", async (req: Request, res: Response) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log(`[WEBHOOK] Email incoming from: ${body?.from}`);

    // Use the email adapter directly
    const { emailInboundAdapter } = await import("@chatcenter/shared");

    if (!emailInboundAdapter.canHandle(body)) {
      console.warn("Email webhook: invalid payload");
      return;
    }

    // Resolve channel account by recipient email
    const recipientEmail = emailInboundAdapter.resolveChannelAccountExternalId(body);
    if (!recipientEmail) {
      console.warn("Email webhook: no recipient found");
      return;
    }

    const channelAccount = await prisma.channelAccount.findFirst({
      where: { externalId: recipientEmail, channel: "EMAIL", isActive: true },
    });

    if (!channelAccount) {
      console.warn(`No email channel account found for: ${recipientEmail}`);
      return;
    }

    const tenantId = channelAccount.tenantId;
    const channelAccountId = channelAccount.id;

    // Extract and enqueue messages
    const messages = emailInboundAdapter.extractMessages(body);
    for (const msg of messages) {
      await incomingMessageQueue.add(
        "process",
        {
          tenantId,
          channel: "EMAIL",
          channelAccountId,
          normalizedMessage: {
            externalMessageId: msg.externalMessageId,
            senderId: msg.senderId,
            senderDisplayName: msg.senderDisplayName,
            timestamp: msg.timestamp.toISOString(),
            contentType: msg.content.type,
            body: msg.content.text || "",
            messageType: "email",
          },
        },
        { attempts: 3, backoff: { type: "exponential", delay: 1000 } }
      );
    }
  } catch (err) {
    console.error("Email webhook error:", err);
  }
});

// ─── Gmail Webhook (POST) - Google Pub/Sub push ────────────────

router.post("/gmail", async (req: Request, res: Response) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log(`[WEBHOOK] Gmail push notification received`);

    if (!gmailInboundAdapter.canHandle(body)) {
      console.warn("Gmail webhook: invalid payload");
      return;
    }

    const emailAddress = gmailInboundAdapter.resolveChannelAccountExternalId(body);
    if (!emailAddress) {
      console.warn("Gmail webhook: no email address found");
      return;
    }

    const channelAccount = await prisma.channelAccount.findFirst({
      where: { externalId: emailAddress, channel: "GMAIL", isActive: true },
    });

    if (!channelAccount) {
      console.warn(`No Gmail channel account found for: ${emailAddress}`);
      return;
    }

    const tenantId = channelAccount.tenantId;
    const channelAccountId = channelAccount.id;

    // Decrypt credentials for Gmail API calls
    const rawCreds = channelAccount.credentials;
    const credentials = typeof rawCreds === "string" ? decryptCredentials(rawCreds) : (rawCreds as any);

    // Extract historyId from Pub/Sub notification
    let pubsubHistoryId: string;
    try {
      const pubsubData = JSON.parse(
        Buffer.from(body.message.data, "base64").toString("utf8")
      );
      pubsubHistoryId = pubsubData.historyId?.toString() || "";
    } catch {
      console.warn("Gmail webhook: failed to parse Pub/Sub data");
      return;
    }

    // Get lastHistoryId from platformMeta
    const platformMeta = (channelAccount.platformMeta as any) || {};
    const lastHistoryId = platformMeta.lastHistoryId?.toString();

    if (!lastHistoryId) {
      // No lastHistoryId stored yet — store current one and skip
      console.log(`[WEBHOOK] Gmail: no lastHistoryId, storing ${pubsubHistoryId}`);
      await prisma.channelAccount.update({
        where: { id: channelAccountId },
        data: { platformMeta: { ...platformMeta, lastHistoryId: pubsubHistoryId } },
      });
      return;
    }

    // Fetch actual emails from Gmail API
    const { messages, newHistoryId } = await gmailFetchNewMessages(
      credentials,
      lastHistoryId,
      emailAddress!
    );

    console.log(`[WEBHOOK] Gmail: fetched ${messages.length} new message(s) for ${emailAddress}`);

    // Enqueue each real message
    for (const msg of messages) {
      await incomingMessageQueue.add(
        "process",
        {
          tenantId,
          channel: "GMAIL",
          channelAccountId,
          normalizedMessage: {
            externalMessageId: msg.messageId,
            senderId: msg.senderId,
            senderDisplayName: msg.senderDisplayName,
            timestamp: new Date().toISOString(),
            contentType: "text",
            body: msg.body,
            subject: msg.subject,
            messageType: "email",
          },
        },
        { attempts: 3, backoff: { type: "exponential", delay: 1000 } }
      );
    }

    // Update lastHistoryId so we don't re-fetch the same messages
    await prisma.channelAccount.update({
      where: { id: channelAccountId },
      data: { platformMeta: { ...platformMeta, lastHistoryId: newHistoryId } },
    });
  } catch (err) {
    console.error("Gmail webhook error:", err);
  }
});

// ─── Outlook Webhook (POST) - Microsoft Graph subscriptions ────

router.post("/outlook", async (req: Request, res: Response) => {
  // Microsoft Graph subscription validation: respond to validationToken query
  const validationToken = req.query.validationToken as string;
  if (validationToken) {
    console.log("[WEBHOOK] Outlook subscription validation");
    res.status(200).contentType("text/plain").send(validationToken);
    return;
  }

  res.sendStatus(202);

  try {
    const body = req.body;
    console.log(`[WEBHOOK] Outlook notification received, count=${body?.value?.length || 0}`);

    if (!outlookInboundAdapter.canHandle(body)) {
      console.warn("Outlook webhook: invalid payload");
      return;
    }

    // Outlook sends subscriptionId which maps to our channel account
    const subscriptionId = outlookInboundAdapter.resolveChannelAccountExternalId(body);

    // Find channel account by subscriptionId stored in platformMeta
    let channelAccount;
    if (subscriptionId) {
      // Search by subscriptionId in platformMeta
      const accounts = await prisma.channelAccount.findMany({
        where: { channel: "OUTLOOK", isActive: true },
      });
      channelAccount = accounts.find((a) => {
        const meta = a.platformMeta as any;
        return meta?.subscriptionId === subscriptionId;
      });
    }

    if (!channelAccount) {
      console.warn(`No Outlook channel account found for subscription: ${subscriptionId}`);
      return;
    }

    const tenantId = channelAccount.tenantId;
    const channelAccountId = channelAccount.id;

    const messages = outlookInboundAdapter.extractMessages(body);
    for (const msg of messages) {
      await incomingMessageQueue.add(
        "process",
        {
          tenantId,
          channel: "OUTLOOK",
          channelAccountId,
          normalizedMessage: {
            externalMessageId: msg.externalMessageId,
            senderId: msg.senderId,
            senderDisplayName: msg.senderDisplayName,
            timestamp: msg.timestamp.toISOString(),
            contentType: msg.content.type,
            body: msg.content.text || "",
            messageType: "text",
          },
        },
        { attempts: 3, backoff: { type: "exponential", delay: 1000 } }
      );
    }
  } catch (err) {
    console.error("Outlook webhook error:", err);
  }
});

// ─── Slack Webhook (POST) - Events API ─────────────────────────

router.post("/slack", async (req: Request, res: Response) => {
  const body = req.body;

  // Slack URL verification challenge
  if (body?.type === "url_verification") {
    console.log("[WEBHOOK] Slack URL verification");
    res.status(200).json({ challenge: body.challenge });
    return;
  }

  // Verify Slack request signature
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET || "";
  if (slackSigningSecret) {
    const timestamp = req.headers["x-slack-request-timestamp"] as string;
    const slackSignature = req.headers["x-slack-signature"] as string;
    const rawBody = (req as any).rawBody;

    if (timestamp && slackSignature && rawBody) {
      const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
      if (parseInt(timestamp) < fiveMinutesAgo) {
        console.warn("[WEBHOOK] Slack request too old, possible replay attack");
        res.sendStatus(403);
        return;
      }

      const sigBasestring = `v0:${timestamp}:${rawBody.toString()}`;
      const mySignature = "v0=" + crypto.createHmac("sha256", slackSigningSecret).update(sigBasestring).digest("hex");

      try {
        if (!crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(slackSignature))) {
          console.error("[WEBHOOK] Invalid Slack signature");
          res.sendStatus(403);
          return;
        }
      } catch {
        console.error("[WEBHOOK] Slack signature verification failed");
        res.sendStatus(403);
        return;
      }
    }
  }

  res.sendStatus(200);

  try {
    console.log(`[WEBHOOK] Slack event: type=${body?.event?.type}, team=${body?.team_id}`);

    if (!slackInboundAdapter.canHandle(body)) {
      return;
    }

    const teamId = slackInboundAdapter.resolveChannelAccountExternalId(body);
    if (!teamId) {
      console.warn("Slack webhook: no team_id found");
      return;
    }

    const channelAccount = await prisma.channelAccount.findFirst({
      where: { externalId: teamId, channel: "SLACK", isActive: true },
    });

    if (!channelAccount) {
      console.warn(`No Slack channel account found for team: ${teamId}`);
      return;
    }

    const tenantId = channelAccount.tenantId;
    const channelAccountId = channelAccount.id;

    // Skip messages from the bot itself
    const botUserId = (channelAccount.platformMeta as any)?.botUserId;
    if (body.event?.user === botUserId) return;

    const messages = slackInboundAdapter.extractMessages(body);
    for (const msg of messages) {
      // For threaded messages, encode the thread info in the sender ID for routing
      const slackChannel = body.event?.channel || "";
      const threadTs = body.event?.thread_ts || "";
      const recipientId = threadTs ? `${slackChannel}:${threadTs}` : slackChannel;

      await incomingMessageQueue.add(
        "process",
        {
          tenantId,
          channel: "SLACK",
          channelAccountId,
          normalizedMessage: {
            externalMessageId: msg.externalMessageId,
            senderId: msg.senderId,
            senderDisplayName: msg.senderDisplayName,
            timestamp: msg.timestamp.toISOString(),
            contentType: msg.content.type,
            body: msg.content.text || "",
            messageType: "text",
            metadata: {
              slackChannel,
              threadTs,
              recipientId,
            },
          },
        },
        { attempts: 3, backoff: { type: "exponential", delay: 1000 } }
      );
    }
  } catch (err) {
    console.error("Slack webhook error:", err);
  }
});

export default router;
