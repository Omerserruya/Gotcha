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
  crossTenantMiddleware,
  verifyWebhookSignature,
  verifySharedSecretToken,
  timingSafeEqualStr,
  reportOperationalFailure,
  ERROR_CODES,
} from "@chatcenter/shared";

const IS_PRODUCTION = process.env.NODE_ENV === "production";
import type { NormalizedInboundMessage, NormalizedStatusUpdate, NormalizedOutboundEcho } from "@chatcenter/shared";

const router = Router();

// Inbound webhooks arrive without a user JWT - the tenant is derived by
// looking up the target ChannelAccount across all tenants. That lookup
// is a legitimate cross-tenant query; enable the Prisma tenant-guard
// opt-out for this entire router. Safe because these endpoints verify
// provider signatures before touching anything.
router.use(crossTenantMiddleware);

// Webhook verification (GET) - shared by WhatsApp and Messenger
router.get("/", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode !== "subscribe" || token !== verifyToken) {
    // The Meta verification handshake failed. Either the configured token
    // drifted from the one in the Meta dashboard - in which case NO webhook
    // will ever be delivered - or someone is probing the endpoint.
    reportOperationalFailure({
      errorCode: ERROR_CODES.webhook_verification_failed,
      domain: "webhook", service: "webhook", provider: "meta",
      context: { mode: String(mode ?? "none"), configured: Boolean(verifyToken) },
    });
  }
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

    // Surface `failed` message statuses as their own untruncated log line.
    // The block above caps at 500 chars, which chops off the error code we
    // need to diagnose template rejects. Walk the payload for WhatsApp
    // `statuses[].status === "failed"` entries and emit one line each
    // carrying the full wamid + error code + error title + error_data.
    try {
      const entries = Array.isArray(body?.entry) ? body.entry : [];
      for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const ch of changes) {
          const statuses = Array.isArray(ch?.value?.statuses) ? ch.value.statuses : [];
          for (const s of statuses) {
            if (s?.status !== "failed") continue;
            const wamid = String(s?.id ?? "").slice(-32);
            const errs = Array.isArray(s?.errors) ? s.errors : [];
            for (const e of errs) {
              console.warn(
                `[WEBHOOK.FAIL] wamid=...${wamid} code=${e?.code ?? "?"} title=${JSON.stringify(e?.title ?? "")} details=${JSON.stringify(e?.error_data ?? e?.message ?? "")}`,
              );
            }
            if (errs.length === 0) {
              console.warn(`[WEBHOOK.FAIL] wamid=...${wamid} status=failed (no errors array)`);
            }
          }
        }
      }
    } catch { /* observability only - never crash the webhook on a logging miss */ }

    // Step 1: Detect which platform sent this webhook
    const adapter = detectInboundAdapter(body);
    if (!adapter) {
      console.warn("Webhook received from unknown platform:", body?.object);
      return;
    }

    // Step 2: Verify signature (MANDATORY, fail-closed). Verification is done
    // via the shared verifier so no route can regress to the old "skip when the
    // header is absent" bypass. A missing signature, missing/unconfigured app
    // secret, or HMAC mismatch all drop the request.
    const appSecret = process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET;
    const verdict = verifyWebhookSignature({
      secret: appSecret,
      rawBody: (req as any).rawBody,
      signature: req.headers[adapter.getSignatureHeader()] as string | undefined,
      verify: (s, b, sig) => adapter.verifySignature(s, b, sig),
    });
    if (!verdict.ok) {
      console.error(`[WEBHOOK] Rejected ${adapter.channel} webhook: ${verdict.reason}`);
      // Single failures are internet background noise - a scanner, a stale
      // secret, a provider replaying an old delivery. The RATE is the signal,
      // which is why the alert on this code is a spike rule and not per-event.
      reportOperationalFailure({
        errorCode: ERROR_CODES.webhook_signature_invalid,
        domain: "webhook", service: "webhook",
        provider: String(adapter.channel).toLowerCase(),
        context: { reason: verdict.reason },
      });
      return;
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

    // Step 4b: Extract and enqueue comment events (IG comments, FB feed
    // comments). Different job name → handled by a separate processor on the
    // same incoming-worker. Adapters that don't implement extractCommentEvents
    // simply yield no events.
    const commentEvents = adapter.extractCommentEvents?.(body) || [];
    for (const ev of commentEvents) {
      await incomingMessageQueue.add(
        "process-comment",
        {
          tenantId,
          channel: adapter.channel as "INSTAGRAM" | "MESSENGER",
          channelAccountId,
          comment: {
            commentId: ev.commentId,
            postId: ev.postId,
            postPermalink: ev.postPermalink,
            text: ev.text,
            fromUserId: ev.fromUserId,
            fromUsername: ev.fromUsername,
            timestamp: ev.timestamp.toISOString(),
            parentCommentId: ev.parentCommentId,
          },
        },
        { attempts: 3, backoff: { type: "exponential", delay: 1000 } }
      );
    }

    // Step 4c: Messages the BUSINESS sent from a provider-native app, mirrored
    // back to us. WhatsApp Coexistence only today: the owner replied from the
    // WhatsApp Business app on their phone. Separate job name → separate
    // handler, because an echo is OUTBOUND and must never be fed to the bot as
    // if the customer had written it.
    const echoes = adapter.extractOutboundEchoes?.(body) || [];
    for (const echo of echoes) {
      const { body: echoBody, messageType, mediaUrl } = normalizeContentToBodyAndType(echo);
      await incomingMessageQueue.add(
        "process-echo",
        {
          tenantId,
          channel: adapter.channel as "WHATSAPP",
          channelAccountId,
          echo: {
            externalMessageId: echo.externalMessageId,
            customerExternalId: echo.customerExternalId,
            businessExternalId: echo.businessExternalId,
            timestamp: echo.timestamp.toISOString(),
            contentType: echo.content.type,
            body: echoBody,
            messageType,
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

// Shared by the inbound and the business-app-echo paths: both carry the same
// normalized `content`, and both need the same body/type/media flattening.
function normalizeContentToBodyAndType(
  msg: Pick<NormalizedInboundMessage | NormalizedOutboundEcho, "content">,
): { body: string; messageType: string; mediaUrl?: string } {
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
    // Persist Meta's failure reason when present so the operator can see
    // *why* - empty error_message after a FAILED webhook is unhelpful. Store
    // BOTH the human string (errorMessage column) and the full structured
    // provider breakdown (metadata.sendError) so an async delivery failure is
    // as diagnosable as a synchronous send failure.
    const failureData =
      mappedStatus === "FAILED" && (status.errorMessage || status.error)
        ? {
            ...(status.errorMessage ? { errorMessage: status.errorMessage } : {}),
            ...(status.error
              ? {
                  metadata: {
                    ...((message.metadata && typeof message.metadata === "object")
                      ? (message.metadata as Record<string, any>)
                      : {}),
                    sendError: status.error,
                  },
                }
              : {}),
          }
        : {};
    await prisma.message.update({
      where: { id: message.id },
      data: {
        status: mappedStatus as any,
        ...failureData,
      },
    });
    // Mirror onto ScheduledMessage so its UI reflects the real outcome
    // instead of the optimistic SENT the scheduled worker set earlier.
    if (mappedStatus === "FAILED" && (message as any).scheduledMessageId) {
      try {
        await prisma.scheduledMessage.update({
          where: { id: (message as any).scheduledMessageId },
          data: {
            status: "FAILED",
            error: status.errorMessage ?? "Delivery failed",
          },
        });
      } catch (err: any) {
        console.warn("[webhook] scheduled-message status mirror failed:", err?.message);
      }
    }
    await publishEvent({
      event: "message:status",
      tenantId,
      data: {
        messageId: message.id,
        conversationId: message.conversationId,
        status: mappedStatus,
        error: mappedStatus === "FAILED" ? status.errorMessage ?? null : null,
        sendError: mappedStatus === "FAILED" ? status.error ?? null : null,
        scheduledMessageId: (message as any).scheduledMessageId ?? null,
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

    // MANDATORY signature verification (fail-closed). The inbound-email provider
    // signs the raw body with EMAIL_WEBHOOK_SECRET (HMAC-SHA256). Without this,
    // the tenant is resolved from the attacker-controlled recipient address and
    // anyone could inject a forged customer email into any tenant.
    const emailVerdict = verifyWebhookSignature({
      secret: process.env.EMAIL_WEBHOOK_SECRET,
      rawBody: (req as any).rawBody,
      signature: req.headers[emailInboundAdapter.getSignatureHeader()] as string | undefined,
      verify: (s, b, sig) => emailInboundAdapter.verifySignature(s, b, sig),
    });
    if (!emailVerdict.ok) {
      console.error(`[WEBHOOK] Rejected email webhook: ${emailVerdict.reason}`);
      return;
    }

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

    // Verify the Google Pub/Sub push token. Configure the push subscription URL
    // with ?token=<GMAIL_PUBSUB_TOKEN>; Google echoes it on every push. Missing
    // or mismatched token is dropped (fail-closed in production).
    const gmailVerdict = verifySharedSecretToken({
      expected: process.env.GMAIL_PUBSUB_TOKEN,
      provided: (req.query.token as string | undefined) ?? undefined,
      isProduction: IS_PRODUCTION,
      label: "Gmail Pub/Sub",
    });
    if (!gmailVerdict.ok) {
      console.error(`[WEBHOOK] Rejected Gmail webhook: ${gmailVerdict.reason}`);
      return;
    }

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
      // No lastHistoryId stored yet - store current one and skip
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
    // Signature already verified upstream, so this is a REAL delivery we
    // failed to process. No raw payload travels - only what it was and why.
    reportOperationalFailure({
      errorCode: ERROR_CODES.webhook_processing_failed,
      domain: "webhook", service: "webhook", provider: "gmail",
      cause: err,
      context: { stage: "process" },
    });
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

    // Verify the Microsoft Graph clientState (set at subscription creation).
    // Every notification must carry the matching secret, else it is dropped
    // (fail-closed in production).
    const notifications: any[] = Array.isArray(body?.value) ? body.value : [];
    for (const n of notifications) {
      const outlookVerdict = verifySharedSecretToken({
        expected: process.env.OUTLOOK_WEBHOOK_CLIENT_STATE,
        provided: n?.clientState,
        isProduction: IS_PRODUCTION,
        label: "Outlook clientState",
      });
      if (!outlookVerdict.ok) {
        console.error(`[WEBHOOK] Rejected Outlook webhook: ${outlookVerdict.reason}`);
        return;
      }
    }

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

  // MANDATORY Slack signature verification (fail-closed). Slack signs
  // `v0:timestamp:rawBody` with SLACK_SIGNING_SECRET (HMAC-SHA256) and sends
  // it in x-slack-signature. The old code only verified when the secret was
  // set AND all headers were present, so an unset secret OR an omitted
  // signature header bypassed verification entirely - identical to the C-2
  // Meta bypass. Now: unset secret rejects in production; a missing timestamp,
  // signature, or raw body rejects; a stale timestamp or HMAC mismatch rejects.
  // Every drop returns BEFORE the message is enqueued.
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
  const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
  const slackSignature = req.headers["x-slack-signature"] as string | undefined;
  const rawBody = (req as any).rawBody as Buffer | undefined;

  if (!slackSigningSecret) {
    if (IS_PRODUCTION) {
      console.error("[WEBHOOK] Rejected Slack webhook: SLACK_SIGNING_SECRET not configured");
      res.sendStatus(403);
      return;
    }
    console.warn("[WEBHOOK] SLACK_SIGNING_SECRET not set; allowing Slack webhook in non-production only");
  } else {
    if (!timestamp || !slackSignature || !rawBody) {
      console.error("[WEBHOOK] Rejected Slack webhook: missing signature material");
      res.sendStatus(403);
      return;
    }
    const ts = parseInt(timestamp, 10);
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
    if (!Number.isFinite(ts) || ts < fiveMinutesAgo) {
      console.warn("[WEBHOOK] Rejected Slack webhook: stale/invalid timestamp (possible replay)");
      res.sendStatus(403);
      return;
    }
    const sigBasestring = `v0:${timestamp}:${rawBody.toString()}`;
    const mySignature = "v0=" + crypto.createHmac("sha256", slackSigningSecret).update(sigBasestring).digest("hex");
    if (!timingSafeEqualStr(mySignature, slackSignature)) {
      console.error("[WEBHOOK] Rejected Slack webhook: signature mismatch");
      res.sendStatus(403);
      return;
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
