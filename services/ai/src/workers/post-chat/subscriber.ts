/**
 * Post-chat subscriber - runs the post-conversation pipeline whenever a
 * non-voice conversation is closed.
 *
 * Listens for `conversation:closed` on the shared event bus. Voice
 * conversations are handled separately by voice-postcall (they emit
 * `voice.session.ended` instead).
 *
 * Idempotency: runPostChatPipeline() guards against re-running on a
 * conversation that already has a structured summary in CallAnalysis.meta,
 * so duplicate fires are safe.
 */

import { prisma, subscribeToEvents, type ServiceEvent } from "@chatcenter/shared";
import { runPostChatPipeline } from "../../services/post-chat-pipeline.service";
import { refreshCustomerBriefFromConversation } from "../../services/customer-brief.service";
import { resolveEffectiveLocale } from "@chatcenter/shared";
import { syncCloseToCrm } from "../../routes/crm-panel";
import { analyzeConversationOnClose } from "../../services/conversation-analysis.service";

let _sub: ReturnType<typeof subscribeToEvents> | null = null;
let _started = false;

interface ClosedEventData {
  id?: string;
  conversationId?: string;
  channel?: string;
  tenantId?: string;
  status?: string;
}

/**
 * Conversation intelligence (intent, sentiment, topics) for a close. Never
 * blocks or fails the close; the sweeper retries what this misses.
 */
function analyze(tenantId: string, conversationId: string, trigger: "closed" | "updated"): void {
  analyzeConversationOnClose(tenantId, conversationId, { trigger })
    .then((out) => { if (out !== "up_to_date" && out !== "locked") console.log(`[conversation-analysis] conv=${conversationId} ${trigger}: ${out}`); })
    .catch((err) => console.warn(`[conversation-analysis] conv=${conversationId} failed:`, (err as { message?: string })?.message ?? err));
}

/**
 * Two close paths announce only `conversation:updated` with status CLOSED (the
 * flow builder's close node, an expired comment-DM bridge). They get the
 * analysis, not the post-chat pipeline: its CRM writes for those paths would
 * be a new behaviour, decided separately.
 */
async function handleUpdatedClosed(evt: ServiceEvent): Promise<void> {
  if (evt.event !== "conversation:updated") return;
  const data = (evt.data ?? {}) as ClosedEventData;
  if (data.status !== "CLOSED") return;
  const conversationId = data.id ?? data.conversationId;
  const tenantId = evt.tenantId ?? data.tenantId;
  if (!conversationId || !tenantId) return;
  analyze(String(tenantId), String(conversationId), "updated");
}

async function handleClosed(evt: ServiceEvent): Promise<void> {
  if (evt.event === "conversation:updated") return handleUpdatedClosed(evt);
  if (evt.event !== "conversation:closed") return;
  const data = (evt.data ?? {}) as ClosedEventData;
  const conversationId = data.id ?? data.conversationId;
  if (!conversationId) return;
  const tenantId = evt.tenantId ?? data.tenantId;
  if (!tenantId) return;

  // Skip voice conversations - they have their own pipeline.
  let channel = data.channel;
  if (!channel) {
    const row = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { channel: true },
    });
    channel = row?.channel as unknown as string;
  }
  if (channel === "VOICE") return;

  const out = await runPostChatPipeline({
    tenantId: String(tenantId),
    conversationId: String(conversationId),
    actorId: "post-chat-subscriber",
  });
  console.log(
    `[post-chat] conv=${conversationId} ok=${out.ok} summ=${out.summarized} crm=${out.crmWritten} tasks=${out.tasksCreated} fup=${out.followupScheduled} notes=${out.notes.join(",")}`,
  );

  // After the pipeline: its summary is on the conversation and is reused.
  analyze(String(tenantId), String(conversationId), "closed");

  // Refresh the persistent customer brief AFTER the per-conversation
  // summary is on disk - that way loadCustomerContext sees this
  // conversation's analysis and the cross-channel brief reflects it.
  // Best-effort: a failure here MUST NOT block conversation close, so we
  // catch and log.
  // Resolve the tenant's system language so the persistent brief gets
  // generated in the right tongue (briefs are stored per-locale on the
  // CustomerBrief table). Falls back to "en" on failure - non-fatal.
  const briefLocaleInfo = await resolveEffectiveLocale({
    tenantId: String(tenantId),
  }).catch(() => null);
  refreshCustomerBriefFromConversation({
    tenantId: String(tenantId),
    conversationId: String(conversationId),
    sourceEvent: "chat.closed",
    locale: briefLocaleInfo?.effective,
  })
    .then((rec) => {
      if (rec) console.log(`[customer-brief] refreshed conv=${conversationId} identity=${rec.identityKey} locale=${rec.locale}`);
    })
    .catch((err) => {
      console.warn(
        `[customer-brief] refresh failed conv=${conversationId}:`,
        (err as { message?: string })?.message ?? err,
      );
    });

  // Project the closed conversation as an activity into the tenant's CRM
  // (Zoho Note / HubSpot Note / Salesforce Task). This is what gives agents
  // a "call log" entry per closed chat - duration, message count, summary,
  // sentiment, action items. The manual UI close path already calls this
  // via POST /api/crm/conversation/:id/sync-close. Bot- and idle-closed
  // conversations need it fired from here, otherwise they never log to CRM.
  // Best-effort: a failure must not affect anything else.
  syncCloseToCrm(String(tenantId), String(conversationId))
    .catch((err) => {
      console.warn(
        `[crm-sync-close] background fire failed conv=${conversationId}:`,
        (err as { message?: string })?.message ?? err,
      );
    });
}

export function startPostChatSubscriber(): void {
  if (_started) return;
  _started = true;
  try {
    _sub = subscribeToEvents((evt: ServiceEvent) => {
      handleClosed(evt).catch((err) => {
        console.warn(
          "[post-chat.subscriber] handler error:",
          (err as { message?: string })?.message ?? err,
        );
      });
    });
    console.log("[post-chat] subscriber started (conversation:closed)");
  } catch (err) {
    console.warn(
      "[post-chat.subscriber] subscribe failed:",
      (err as { message?: string })?.message,
    );
  }
}

export async function stopPostChatSubscriber(): Promise<void> {
  if (_sub) {
    try {
      await _sub.quit();
    } catch {
      /* ignore */
    }
    _sub = null;
  }
  _started = false;
}
