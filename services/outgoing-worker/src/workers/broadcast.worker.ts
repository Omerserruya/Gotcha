import { prisma, createWorker, outgoingMessageQueue, publishEvent, broadcastQueue } from "@chatcenter/shared";
import type { BroadcastJob } from "@chatcenter/shared";

/** Extract `{{var}}` placeholder keys from a string, preserving order of
 *  appearance. Used to know which variable values to send to Meta. */
function extractPlaceholders(text: string): string[] {
  const re = /\{\{\s*([\w-]+)\s*\}\}/g;
  const seen = new Set<string>();
  const order: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const key = m[1];
    if (!seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
  }
  return order;
}

/** Build Meta `template.components` for a recipient.
 *
 * The previous implementation iterated `Object.values(variables)`, which:
 *   - lost placeholder order for named ({{first_name}}) keys
 *   - sent `text: ""` for any unmapped/missing variable, which Meta rejects
 *     with error 131008 ("Parameter of type text is missing text value")
 *   - never emitted `parameter_name` for named-params templates
 *
 * Walk the template body in placeholder order, look up each value, and fall
 * back to the template's declared sample (or a non-empty placeholder) when
 * blank so Meta accepts the message. */
function buildTemplateComponents(
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
    const sample = sampleByKey.get(key);
    if (sample) return sample;
    // Meta rejects empty parameter text - substitute a single dash so the
    // message ships rather than the whole broadcast halting.
    return "-";
  };

  function buildComponent(scope: "header" | "body", text: string) {
    const keys = extractPlaceholders(text);
    if (keys.length === 0) return null;
    const allNumeric = keys.every((k) => /^\d+$/.test(k));
    const componentType = scope === "header" ? "header" : "body";
    if (allNumeric) {
      // Positional ({{1}}, {{2}}) - order parameters by numeric key.
      const sorted = [...keys].sort((a, b) => Number(a) - Number(b));
      return {
        type: componentType,
        parameters: sorted.map((k) => ({ type: "text", text: valueFor(k) })),
      };
    }
    // Named params (newer Meta format) - every parameter MUST carry parameter_name.
    return {
      type: componentType,
      parameters: keys.map((k) => ({ type: "text", parameter_name: k, text: valueFor(k) })),
    };
  }

  if (tmpl.headerType === "TEXT" && tmpl.headerContent) {
    const header = buildComponent("header", tmpl.headerContent);
    if (header) components.push(header);
  } else if (
    tmpl.headerType === "IMAGE" || tmpl.headerType === "VIDEO" || tmpl.headerType === "DOCUMENT"
  ) {
    // Per-campaign override (`headerMediaOverride`) wins over the template
    // example URL - that's the value the operator entered in the wizard.
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
    const body = buildComponent("body", tmpl.body);
    if (body) components.push(body);
  }
  return components;
}

async function processBroadcastMessage(job: any) {
  const data = job.data as BroadcastJob;
  const { broadcastId, tenantId, channel, channelAccountId, recipientId, recipientExternalId, body, messageType, templateId, variables, headerMediaUrl } = data;

  const recipient = await prisma.broadcastRecipient.findUnique({ where: { id: recipientId } });
  if (!recipient || (recipient.status !== "pending" && recipient.status !== "queued")) return;

  const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
  if (!broadcast || broadcast.status === "CANCELLED" || broadcast.status === "FAILED") {
    // Broadcast halted - mark this recipient skipped and bail.
    await prisma.broadcastRecipient.update({
      where: { id: recipientId },
      data: { status: "skipped", error: `Broadcast ${broadcast?.status ?? "missing"}` },
    });
    return;
  }

  if (recipient.contactId) {
    const contact = await prisma.contact.findUnique({ where: { id: recipient.contactId } });
    if (contact) {
      const optOutChannels = ((contact as any).optOutChannels as string[]) || [];
      if (optOutChannels.includes(channel)) {
        await prisma.broadcastRecipient.update({
          where: { id: recipientId },
          data: { status: "skipped", error: "Contact opted out" },
        });
        await publishBroadcastUpdate(broadcastId, tenantId);
        await checkBroadcastCompletion(broadcastId);
        return;
      }
    }
  }

  // Create the Message row up front (conversationId is nullable for broadcast messages).
  const message = await prisma.message.create({
    data: {
      tenantId,
      conversationId: null,
      channel: channel as any,
      direction: "OUTBOUND",
      body: body || "",
      messageType: messageType || "text",
      status: "PENDING",
      senderName: "Broadcast",
      broadcastId,
    },
  });

  let templateData: any = {};
  if (templateId) {
    const tmpl = await prisma.messageTemplate.findUnique({ where: { id: templateId } });
    if (tmpl) {
      templateData = {
        messageType: "template",
        templateName: tmpl.name,
        templateLanguage: tmpl.language || "en",
        templateComponents: buildTemplateComponents(tmpl, variables, headerMediaUrl),
      };
    }
  }

  await prisma.broadcastRecipient.update({
    where: { id: recipientId },
    data: { status: "queued", messageId: message.id },
  });

  await outgoingMessageQueue.add("send", {
    tenantId,
    conversationId: null,
    channel,
    channelAccountId,
    recipientExternalId,
    body: body || "",
    messageType: templateData.messageType || messageType || "text",
    senderName: "Broadcast",
    messageId: message.id,
    broadcastId,
    broadcastRecipientId: recipientId,
    ...templateData,
  }, {
    attempts: 1, // we handle retries/failure semantics at the broadcast level
  });
}

// ─── Broadcast result writeback (called from outgoing.worker) ─────────────────

interface RecordResultInput {
  tenantId: string;
  broadcastId: string | undefined;
  broadcastRecipientId: string | undefined;
  success: boolean;
  errorMessage?: string;
}

export async function recordBroadcastResult(input: RecordResultInput): Promise<void> {
  const { tenantId, broadcastId, broadcastRecipientId, success, errorMessage } = input;
  if (!broadcastId || !broadcastRecipientId) return;

  try {
    await prisma.broadcastRecipient.update({
      where: { id: broadcastRecipientId },
      data: success
        ? { status: "sent", sentAt: new Date() }
        : { status: "failed", error: (errorMessage || "send failed").slice(0, 500) },
    });

    const updated = await prisma.broadcast.update({
      where: { id: broadcastId },
      data: success ? { sentCount: { increment: 1 } } : { failedCount: { increment: 1 } },
    });

    // Auto-stop: if the very first attempted send failed, treat as systemic
    // (bad token, billing block, bad template, wrong account) and halt the
    // whole broadcast so we don't hammer the API or run up failures.
    if (!success && updated.sentCount === 0 && updated.failedCount === 1 && updated.status === "SENDING") {
      await haltBroadcast(broadcastId, tenantId, errorMessage || "Send failed");
      return;
    }

    await publishBroadcastUpdate(broadcastId, tenantId);
    await checkBroadcastCompletion(broadcastId);
  } catch (err: any) {
    console.error("[outgoing] Failed to record broadcast result:", err.message);
  }
}

async function haltBroadcast(broadcastId: string, tenantId: string, errorMessage: string) {
  const truncated = errorMessage.slice(0, 1000);
  console.log(`[BROADCAST] Halting ${broadcastId}: ${truncated}`);

  // Drop queued jobs for this broadcast so the worker doesn't keep pulling them.
  try {
    const waiting = await broadcastQueue.getJobs(["waiting", "delayed", "paused"]);
    for (const job of waiting) {
      if ((job.data as BroadcastJob)?.broadcastId === broadcastId) {
        await job.remove();
      }
    }
  } catch (err: any) {
    console.error("[BROADCAST] Failed to drain queued jobs:", err.message);
  }

  // Mark remaining recipients as skipped with the error.
  await prisma.broadcastRecipient.updateMany({
    where: { broadcastId, status: { in: ["pending", "queued"] } },
    data: { status: "skipped", error: `Broadcast halted: ${truncated}`.slice(0, 500) },
  });

  await prisma.broadcast.update({
    where: { id: broadcastId },
    data: { status: "FAILED", lastError: truncated, completedAt: new Date() },
  });

  await publishBroadcastUpdate(broadcastId, tenantId);
}

export async function publishBroadcastUpdate(broadcastId: string, tenantId: string) {
  try {
    const bc = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
    if (!bc) return;
    await publishEvent({
      event: "broadcast:updated",
      tenantId,
      data: bc,
    });
  } catch (err: any) {
    console.error("[BROADCAST] publish update failed:", err.message);
  }
}

export async function checkBroadcastCompletion(broadcastId: string) {
  const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
  if (!broadcast || broadcast.status !== "SENDING") return;

  // Count terminal recipient statuses (sent + failed + skipped) rather than
  // comparing to totalRecipients directly - keeps the check correct if the
  // broadcast gets new recipients added mid-send.
  const terminalCount = await prisma.broadcastRecipient.count({
    where: {
      broadcastId,
      status: { in: ["sent", "failed", "skipped"] },
    },
  });

  if (terminalCount >= broadcast.totalRecipients) {
    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await publishBroadcastUpdate(broadcastId, broadcast.tenantId);
    console.log(`[BROADCAST] ${broadcastId} completed: ${broadcast.sentCount} sent, ${broadcast.failedCount} failed`);
  }
}

export function startBroadcastWorker() {
  const worker = createWorker("broadcast-messages", async (job) => {
    await processBroadcastMessage(job);
  }, {
    concurrency: 20,
    limiter: {
      max: 80,
      duration: 1000,
    },
  });

  worker.on("failed", async (job, err) => {
    console.error(`[BROADCAST] Job ${job?.id} failed:`, err.message);
    if (!job) return;
    const data = job.data as BroadcastJob;
    try {
      await recordBroadcastResult({
        tenantId: data.tenantId,
        broadcastId: data.broadcastId,
        broadcastRecipientId: data.recipientId,
        success: false,
        errorMessage: err.message,
      });
    } catch (e: any) {
      console.error("[BROADCAST] Failed to record failure:", e.message);
    }
  });

  console.log("[BROADCAST] Worker started with rate limiting (80 msg/s)");
  return worker;
}
