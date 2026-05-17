import { prisma, outgoingMessageQueue, createWorker, scheduledMessageQueue, flowResumeQueue } from "@chatcenter/shared";

/** Walk the template body in placeholder order. Mirrors the broadcast
 *  worker's helper so scheduled template sends honor named + numeric
 *  placeholders and supply non-empty parameter text to Meta. */
function extractPlaceholders(text: string): string[] {
  const re = /\{\{\s*([\w-]+)\s*\}\}/g;
  const seen = new Set<string>();
  const order: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      order.push(m[1]);
    }
  }
  return order;
}

function buildScheduledTemplateComponents(
  tmpl: { body?: string | null; headerType?: string | null; headerContent?: string | null; variables?: any },
  values: Record<string, unknown> | undefined,
  headerMediaOverride?: string | null,
): any[] {
  const components: any[] = [];
  const declared = Array.isArray(tmpl.variables) ? tmpl.variables : [];
  const sampleByKey = new Map<string, string>();
  for (const v of declared) {
    if (v && typeof v.key === "string" && typeof v.sample === "string" && v.sample.trim()) {
      sampleByKey.set(v.key, v.sample);
    }
  }
  const valueFor = (key: string): string => {
    const raw = values && (values as Record<string, unknown>)[key];
    if (raw != null && String(raw).length > 0) return String(raw);
    return sampleByKey.get(key) || "-";
  };

  const componentFor = (scope: "header" | "body", text: string) => {
    const keys = extractPlaceholders(text);
    if (keys.length === 0) return null;
    const componentType = scope === "header" ? "header" : "body";
    const allNumeric = keys.every((k) => /^\d+$/.test(k));
    if (allNumeric) {
      const sorted = [...keys].sort((a, b) => Number(a) - Number(b));
      return { type: componentType, parameters: sorted.map((k) => ({ type: "text", text: valueFor(k) })) };
    }
    return {
      type: componentType,
      parameters: keys.map((k) => ({ type: "text", parameter_name: k, text: valueFor(k) })),
    };
  };

  if (tmpl.headerType === "TEXT" && tmpl.headerContent) {
    const h = componentFor("header", tmpl.headerContent);
    if (h) components.push(h);
  } else if (
    tmpl.headerType === "IMAGE" || tmpl.headerType === "VIDEO" || tmpl.headerType === "DOCUMENT"
  ) {
    const liveUrl = (headerMediaOverride && headerMediaOverride.trim()) || tmpl.headerContent;
    if (liveUrl) {
      const mediaType = tmpl.headerType.toLowerCase() as "image" | "video" | "document";
      components.push({
        type: "header",
        parameters: [{ type: mediaType, [mediaType]: { link: liveUrl } }],
      });
    }
  }
  if (tmpl.body) {
    const b = componentFor("body", tmpl.body);
    if (b) components.push(b);
  }
  return components;
}

async function processScheduledMessages(): Promise<void> {
  const now = new Date();

  const dueMessages = await prisma.scheduledMessage.findMany({
    where: {
      status: "PENDING",
      scheduledAt: { lte: now },
    },
  });

  let processed = 0;

  for (const scheduledMessage of dueMessages) {
    try {
      // Check opt-out — use the resolver so a merged-away contact's
      // scheduled messages (authored before the merge) still honor the
      // opt-out state of the surviving target.
      const { resolveContactByChannelId } = await import("@chatcenter/shared");
      const contact = await resolveContactByChannelId(
        scheduledMessage.tenantId,
        scheduledMessage.channel as any,
        scheduledMessage.recipientExternalId,
      );
      if (contact) {
        const optOutChannels = ((contact as any).optOutChannels as string[]) || [];
        if (optOutChannels.includes(scheduledMessage.channel as string)) {
          await prisma.scheduledMessage.update({
            where: { id: scheduledMessage.id },
            data: { status: "CANCELLED", error: "Recipient opted out" },
          });
          continue;
        }
      }

      // ─── Flow-trigger branch ──────────────────────────────
      // When `flowId` is set, the scheduled message is a chatbot-flow
      // kick: enqueue the existing `flow-resume` queue with the target
      // flow id so the flow-executor (in incoming-worker) starts it from
      // its entry node. The flow runs with the scheduled message's
      // `body` as the inbound payload — useful for time-triggered
      // followups ("send retention check after 7 days of silence").
      //
      // Requires a `conversationId` so the flow has a scope to write
      // into. v1 surfaces a clear FAILED state when missing rather than
      // synthesizing a conversation — keeps the operator decision
      // explicit. Future: auto-upsert OPEN conversation for the channel.
      if (scheduledMessage.flowId) {
        if (!scheduledMessage.conversationId) {
          await prisma.scheduledMessage.update({
            where: { id: scheduledMessage.id },
            data: { status: "FAILED", error: "flow_trigger_needs_conversationId" },
          });
          continue;
        }
        await flowResumeQueue.add(
          "scheduled-flow-trigger",
          {
            tenantId: scheduledMessage.tenantId,
            conversationId: scheduledMessage.conversationId,
            flowKind: "sub",
            flowId: scheduledMessage.flowId,
            resumeNodeId: null,
            channel: String(scheduledMessage.channel).toLowerCase(),
            message: scheduledMessage.body,
          },
          { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
        );
        await prisma.scheduledMessage.update({
          where: { id: scheduledMessage.id },
          data: { status: "SENT", sentAt: new Date() },
        });
        processed++;
        continue;
      }

      // Optimistic status update on the ScheduledMessage row.
      await prisma.scheduledMessage.update({
        where: { id: scheduledMessage.id },
        data: { status: "SENT", sentAt: new Date() },
      });

      // If a template is set, hydrate the template fields so the outgoing
      // worker can call sendTemplateMessage with the right name/language
      // and per-variable values (Meta requires non-empty parameter text +
      // parameter_name for named-format placeholders).
      let templateExtras: Record<string, any> = {};
      if (scheduledMessage.templateId) {
        const tmpl = await prisma.messageTemplate.findUnique({
          where: { id: scheduledMessage.templateId },
        });
        if (tmpl) {
          templateExtras = {
            messageType: "template",
            templateName: tmpl.name,
            templateLanguage: tmpl.language || "en",
            templateComponents: buildScheduledTemplateComponents(
              tmpl,
              (scheduledMessage.variables ?? {}) as Record<string, unknown>,
              scheduledMessage.mediaUrl,
            ),
          };
        }
      }

      // Create the Message row UP FRONT so the outgoing worker has a real
      // id to update with the SENT/FAILED status and externalMessageId.
      // conversationId is nullable on Message — for scheduled sends with
      // no linked conversation this row still gives us a place to record
      // the delivery outcome.
      const messageRow = await prisma.message.create({
        data: {
          tenantId: scheduledMessage.tenantId,
          conversationId: scheduledMessage.conversationId ?? null,
          channel: scheduledMessage.channel as any,
          direction: "OUTBOUND",
          body: scheduledMessage.body,
          messageType: templateExtras.messageType || scheduledMessage.messageType,
          status: "PENDING",
          senderName: "System",
          scheduledMessageId: scheduledMessage.id,
        },
      });

      // Enqueue to outgoing message queue
      await outgoingMessageQueue.add("scheduled-message", {
        tenantId: scheduledMessage.tenantId,
        conversationId: scheduledMessage.conversationId ?? "",
        channel: scheduledMessage.channel as any,
        channelAccountId: scheduledMessage.channelAccountId,
        recipientExternalId: scheduledMessage.recipientExternalId,
        body: scheduledMessage.body,
        messageType: scheduledMessage.messageType,
        senderName: "System",
        messageId: messageRow.id,
        ...templateExtras,
      });

      processed++;
    } catch (err: any) {
      console.error(`[scheduled-worker] Failed to process scheduled message ${scheduledMessage.id}:`, err.message);
      await prisma.scheduledMessage.update({
        where: { id: scheduledMessage.id },
        data: { status: "FAILED", error: err.message },
      }).catch(() => {});
    }
  }

  console.log(`[scheduled-worker] Processed ${processed} scheduled message(s)`);
}

export function startScheduledMessageWorker() {
  // Add a repeatable job that triggers every 30 seconds
  scheduledMessageQueue.add(
    "poll-scheduled-messages",
    {},
    { repeat: { every: 30000 }, jobId: "scheduled-message-poll" }
  );

  createWorker("scheduled-messages", processScheduledMessages, 1);
  console.log("[outgoing-worker] Scheduled message worker started");
}
