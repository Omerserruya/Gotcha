import { Job } from "bullmq";
import {
  prisma,
  HistoricalImportChunkJob,
  isInboundExcluded,
  normalizePhone,
  withHistoricalRecords,
  historicalIntelligenceQueue,
  isForwardTransition,
  HISTORICAL_SOURCE_WINDOW_MS,
  type HistoricalImportStatus,
} from "@chatcenter/shared";

/**
 * Ingestion of imported conversation history.
 *
 * This handler exists to do ONE thing and to be structurally incapable of doing
 * the other. It writes rows. It does not answer anybody.
 *
 * A historical message and a live message are indistinguishable by content and
 * nearly indistinguishable by timestamp, so the separation is made structural
 * rather than conditional: history arrives on its own job name, is handled by
 * this file, and this file imports neither the bot, the router, the flow
 * executor, nor `publishEvent`. There is no branch here that could be taken
 * wrongly, because there is no branch. Compare `processIncomingMessage`, which
 * is where all of that lives.
 *
 * What that protects against, concretely: the AI replying to a customer about a
 * delivery that arrived in March, a flow re-triggering on a two-year-old
 * keyword, an SLA timer starting on a conversation that closed last spring, and
 * 12,000 unread badges appearing in the inbox overnight.
 */

const STEP = {
  CHUNK: "CHUNK_RECEIVED",
  INGEST: "INGEST",
  UNAVAILABLE: "SOURCE_UNAVAILABLE",
  COMPLETE: "SOURCE_COMPLETE",
} as const;

export function processHistoricalChunk(job: Job<HistoricalImportChunkJob>): Promise<void> {
  // The whole handler runs inside the historical scope.
  //
  // `prisma` filters Conversation and Message down to `origin: LIVE` by default
  // so that every query written before this feature existed still means what
  // its author intended. This handler is the one place that must see the other
  // half - it exists to read back exactly what it just wrote - so it opts in
  // once, at the boundary, rather than repeating `origin` on every query
  // inside and eventually missing one.
  return withHistoricalRecords(() => ingestHistoricalChunk(job));
}

async function ingestHistoricalChunk(job: Job<HistoricalImportChunkJob>): Promise<void> {
  const startedAt = Date.now();
  const { tenantId, channelAccountId, source, chunk } = job.data;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true },
  });
  if (!tenant || tenant.status !== "ACTIVE") {
    console.log(
      `[historical-import] skipping chunk for non-active tenant ${tenantId} (status: ${tenant?.status})`,
    );
    return;
  }

  const importRow = await resolveActiveImport({ tenantId, channelAccountId, source });

  // ── The business declined to share, or the source failed outright ──
  //
  // Recorded as an ANSWER, not an error. Meta's 2593109 means the owner
  // switched history sharing off in their app, which is a legitimate choice;
  // showing them a red "import failed" for exercising it would be a lie about
  // whose fault it is, and would push them to "fix" something that is not
  // broken.
  if (chunk.unavailable) {
    await transition(importRow.id, "NOT_AVAILABLE", {
      failureReason: chunk.unavailable.reason,
      sourceMetadata: {
        ...(asRecord(importRow.sourceMetadata) ?? {}),
        declineCode: chunk.unavailable.code ?? null,
      },
    });
    await recordEvent(importRow.id, STEP.UNAVAILABLE, "SKIPPED", chunk.unavailable.reason, {
      code: chunk.unavailable.code ?? null,
    });
    console.log(
      `[historical-import] import=${importRow.id} unavailable code=${chunk.unavailable.code ?? "-"}`,
    );
    return;
  }

  // ── Idempotency, layer one: the chunk itself ──
  //
  // Meta redelivers on any non-2xx and BullMQ retries on throw, so the same
  // (phase, chunkOrder) legitimately arrives more than once. The unique
  // constraint turns that into a no-op instead of a second copy of somebody's
  // conversation. Storing the raw payload also means a parser fix can be
  // replayed against history we already hold - which matters more here than
  // anywhere else, because the source will not send it again.
  let chunkRow: { id: string; processedAt: Date | null };
  try {
    chunkRow = await prisma.historicalImportChunk.create({
      data: {
        importId: importRow.id,
        tenantId,
        phase: chunk.phase,
        chunkOrder: chunk.chunkOrder,
        progress: chunk.progress,
        payload: chunk.messages as unknown as object,
        messageCount: chunk.messages.length,
        threadCount: chunk.threadCount,
      },
      select: { id: true, processedAt: true },
    });
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;
    const existing = await prisma.historicalImportChunk.findUnique({
      where: {
        importId_phase_chunkOrder: {
          importId: importRow.id,
          phase: chunk.phase,
          chunkOrder: chunk.chunkOrder,
        },
      },
      select: { id: true, processedAt: true },
    });
    // Already ingested. Progress still gets refreshed below, because a redelivery
    // can legitimately carry a HIGHER progress number than the first attempt.
    if (existing?.processedAt) {
      await refreshProgress(importRow.id, chunk.progress, chunk.phase);
      return;
    }
    // Created but never finished - a crash between insert and ingest. Fall
    // through and ingest it now.
    if (!existing) return;
    chunkRow = existing;
  }

  const result = await ingestChunk({
    tenantId,
    channelAccountId,
    importId: importRow.id,
    messages: chunk.messages,
  });

  await prisma.historicalImportChunk.update({
    where: { id: chunkRow.id },
    data: { processedAt: new Date() },
  });

  await prisma.historicalImport.update({
    where: { id: importRow.id },
    data: {
      chunksReceived: { increment: 1 },
      importedMessages: { increment: result.created },
      duplicateMessages: { increment: result.duplicates },
      ...(isForwardTransition(importRow.status as HistoricalImportStatus, "SOURCE_SYNCING")
        ? { status: "SOURCE_SYNCING" as const }
        : {}),
    },
  });

  await refreshProgress(importRow.id, chunk.progress, chunk.phase);

  await recordEvent(
    importRow.id,
    STEP.INGEST,
    "SUCCESS",
    null,
    {
      phase: chunk.phase,
      chunkOrder: chunk.chunkOrder,
      progress: chunk.progress,
      created: result.created,
      duplicates: result.duplicates,
      excludedThreads: result.excludedThreads,
      conversations: result.conversations,
    },
    Date.now() - startedAt,
  );

  console.log(
    `[historical-import] import=${importRow.id} phase=${chunk.phase} chunk=${chunk.chunkOrder} ` +
      `progress=${chunk.progress} created=${result.created} dup=${result.duplicates} ` +
      `excluded=${result.excludedThreads}`,
  );

  await maybeCompleteSourceSync(importRow.id);
}

// ─── Import lifecycle ────────────────────────────────────────

/**
 * The import this chunk belongs to, creating one if this is the first chunk.
 *
 * Two chunks can arrive at the same instant and the worker runs them in
 * parallel, so "find, and if absent create" is a race. The partial unique index
 * on `channel_account_id` for unfinished imports is the arbiter: the loser of
 * the race gets P2002 and re-reads the winner's row.
 *
 * An import whose 24-hour Meta window has closed is failed rather than reused.
 * Meta grants exactly one sync per onboarding, so a stale in-flight row is not
 * a resumable transfer - it is a transfer that will never finish, and leaving
 * it open would block the customer's legitimate second attempt after they
 * offboard and sign up again.
 */
async function resolveActiveImport(args: {
  tenantId: string;
  channelAccountId: string;
  source: HistoricalImportChunkJob["source"];
}) {
  const { tenantId, channelAccountId, source } = args;

  const existing = await prisma.historicalImport.findFirst({
    where: {
      channelAccountId,
      status: { notIn: ["COMPLETED", "FAILED", "NOT_AVAILABLE"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    const expired =
      existing.sourceDeadlineAt !== null &&
      existing.sourceDeadlineAt.getTime() < Date.now() &&
      existing.sourceProgress < 100;
    if (!expired) return existing;

    await prisma.historicalImport.update({
      where: { id: existing.id },
      data: {
        status: "FAILED",
        failedStage: "source-sync",
        failureReason:
          "The 24 hour window the source allows for transferring history closed before it finished.",
      },
    });
    await recordEvent(existing.id, STEP.COMPLETE, "FAILED", "source window expired", {
      sourceProgress: existing.sourceProgress,
    });
  }

  try {
    return await prisma.historicalImport.create({
      data: {
        tenantId,
        channelAccountId,
        source,
        status: "SOURCE_SYNCING",
        sourceDeadlineAt: new Date(Date.now() + HISTORICAL_SOURCE_WINDOW_MS),
      },
    });
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;
    const winner = await prisma.historicalImport.findFirst({
      where: {
        channelAccountId,
        status: { notIn: ["COMPLETED", "FAILED", "NOT_AVAILABLE"] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!winner) throw err;
    return winner;
  }
}

/**
 * Progress only ever moves forward.
 *
 * Chunks arrive out of order, so a chunk reporting 40% can land after one
 * reporting 60%. Writing it blindly would make the bar jump backwards, which
 * reads as a fault even though nothing is wrong.
 */
async function refreshProgress(importId: string, progress: number, phase: number): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(progress || 0)));
  await prisma.historicalImport.updateMany({
    where: { id: importId, sourceProgress: { lt: clamped } },
    data: { sourceProgress: clamped },
  });
  await prisma.historicalImport.updateMany({
    where: {
      id: importId,
      OR: [{ sourcePhase: null }, { sourcePhase: { lt: phase } }],
    },
    data: { sourcePhase: phase },
  });
}

/**
 * Hand over to the intelligence pipeline, once and only once.
 *
 * "Done" needs both halves: the source says 100, AND every chunk we hold has
 * actually been ingested. Progress alone is not enough - it is reported
 * alongside a chunk, and the chunk carrying 100 can be processed while an
 * earlier one is still in the queue behind it.
 *
 * The conditional update is the latch. Whichever worker moves the row out of
 * SOURCE_SYNCING enqueues; every other concurrent finisher updates zero rows
 * and enqueues nothing.
 */
async function maybeCompleteSourceSync(importId: string): Promise<void> {
  const row = await prisma.historicalImport.findUnique({
    where: { id: importId },
    select: { id: true, tenantId: true, sourceProgress: true, status: true },
  });
  if (!row || row.sourceProgress < 100) return;
  if (row.status !== "SOURCE_SYNCING" && row.status !== "PENDING") return;

  const unprocessed = await prisma.historicalImportChunk.count({
    where: { importId, processedAt: null },
  });
  if (unprocessed > 0) return;

  const claimed = await prisma.historicalImport.updateMany({
    where: { id: importId, status: { in: ["SOURCE_SYNCING", "PENDING"] } },
    data: {
      status: "SOURCE_COMPLETE",
      sourceCompletedAt: new Date(),
      intelligenceStartedAt: new Date(),
    },
  });
  if (claimed.count === 0) return;

  await recordEvent(importId, STEP.COMPLETE, "SUCCESS", "source transfer complete");

  await historicalIntelligenceQueue.add(
    "stage",
    { tenantId: row.tenantId, importId, stage: "identity" as const },
    { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100 },
  );

  console.log(`[historical-import] import=${importId} source complete, intelligence enqueued`);
}

// ─── Ingestion ───────────────────────────────────────────────

interface IngestResult {
  created: number;
  duplicates: number;
  conversations: number;
  excludedThreads: number;
}

/**
 * Turn one chunk's messages into Conversation and Message rows.
 *
 * V1 groups everything from one customer into a SINGLE historical conversation,
 * deliberately. Splitting a two-year thread into sessions is a hard problem
 * with no obviously right answer, and getting it wrong costs more than not
 * doing it: the intelligence stages read a customer's whole history anyway, and
 * a partial unique index guarantees the one-thread rule holds under replay.
 * Segmentation can be added later without touching anything downstream.
 */
async function ingestChunk(args: {
  tenantId: string;
  channelAccountId: string;
  importId: string;
  messages: HistoricalImportChunkJob["chunk"]["messages"];
}): Promise<IngestResult> {
  const { tenantId, channelAccountId, importId, messages } = args;
  const result: IngestResult = { created: 0, duplicates: 0, conversations: 0, excludedThreads: 0 };

  const byCustomer = new Map<string, typeof messages>();
  for (const m of messages) {
    const list = byCustomer.get(m.customerExternalId);
    if (list) list.push(m);
    else byCustomer.set(m.customerExternalId, [m]);
  }

  for (const [customerExternalId, customerMessages] of byCustomer) {
    // The same exclusion the live and echo paths honour.
    //
    // A Coexistence number delivers EVERY thread on the owner's phone,
    // history included - the accountant, the supplier, their family. A rule
    // that keeps those out of the inbox but lets two years of them into the
    // import, and from there into customer memory and mined knowledge, would
    // be worse than no rule at all.
    if (
      await isInboundExcluded({
        tenantId,
        channel: "WHATSAPP",
        customerExternalId,
        channelAccountId,
      })
    ) {
      result.excludedThreads += 1;
      continue;
    }

    const conversation = await resolveHistoricalConversation({
      tenantId,
      channelAccountId,
      importId,
      customerExternalId,
    });
    if (conversation.created) result.conversations += 1;

    for (const m of customerMessages) {
      const written = await writeHistoricalMessage({
        tenantId,
        importId,
        conversationId: conversation.id,
        message: m,
      });
      if (written) result.created += 1;
      else result.duplicates += 1;
    }

    const timestamps = customerMessages
      .map((m) => new Date(m.timestamp).getTime())
      .filter((t) => Number.isFinite(t) && t > 0);
    await upsertHistoricalCustomer({
      importId,
      tenantId,
      customerExternalId,
      conversationId: conversation.id,
      messages: customerMessages,
      firstAt: timestamps.length ? new Date(Math.min(...timestamps)) : null,
      lastAt: timestamps.length ? new Date(Math.max(...timestamps)) : null,
    });
  }

  return result;
}

/**
 * The one historical conversation for this customer in this import.
 *
 * Never reuses a LIVE conversation, and never lets imported messages land in
 * one. A live thread is a working object - it has routing, a flow cursor, an
 * assignee, an escalation history - and back-filling two years of messages into
 * it would rewrite an agent's open work.
 */
async function resolveHistoricalConversation(args: {
  tenantId: string;
  channelAccountId: string;
  importId: string;
  customerExternalId: string;
}): Promise<{ id: string; created: boolean }> {
  const { tenantId, channelAccountId, importId, customerExternalId } = args;

  const existing = await prisma.conversation.findFirst({
    where: { historicalImportId: importId, customerExternalId },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };

  const contact = await resolveContactSafely(tenantId, customerExternalId);

  try {
    const created = await prisma.conversation.create({
      data: {
        tenantId,
        channel: "WHATSAPP",
        channelAccountId,
        customerExternalId,
        customerName: contact?.displayName ?? null,
        customerAvatarUrl: contact?.avatarUrl ?? undefined,
        origin: "HISTORICAL_IMPORT",
        historicalImportId: importId,
        // CLOSED, and handed to nobody. An imported thread is a record of
        // something that already ended: OPEN would put 1,200 finished
        // conversations into the needs-attention queue, and an assignee would
        // make them somebody's workload.
        status: "CLOSED",
        isHandedOver: false,
        handledBy: null,
        closedAt: new Date(),
      },
      select: { id: true },
    });
    return { id: created.id, created: true };
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;
    const winner = await prisma.conversation.findFirst({
      where: { historicalImportId: importId, customerExternalId },
      select: { id: true },
    });
    if (!winner) throw err;
    return { id: winner.id, created: false };
  }
}

/**
 * Write one imported message. Returns false when it was already there.
 *
 * Idempotency, layer two. The chunk-level guard covers redelivery of a whole
 * batch; this covers the same message appearing in two different chunks, which
 * Meta's phase overlap makes entirely possible at a phase boundary. The partial
 * unique index on imported rows is what makes the check a guarantee rather than
 * a hopeful read-then-write.
 */
async function writeHistoricalMessage(args: {
  tenantId: string;
  importId: string;
  conversationId: string;
  message: HistoricalImportChunkJob["chunk"]["messages"][number];
}): Promise<boolean> {
  const { tenantId, importId, conversationId, message } = args;
  try {
    await prisma.message.create({
      data: {
        tenantId,
        conversationId,
        channel: "WHATSAPP",
        externalMessageId: message.externalMessageId,
        direction: message.direction,
        origin: "HISTORICAL_IMPORT",
        historicalImportId: importId,
        body: message.body,
        messageType: message.messageType,
        // The source already delivered these; there is no status webhook coming
        // for a message from last March, so anything else would strand the row
        // in a state nothing can ever advance.
        status: "DELIVERED",
        createdAt: new Date(message.timestamp),
        fileName: message.fileName,
        // Deliberately NOT resolved to a local file. Meta only issues asset ids
        // for media sent within 14 days of onboarding, so almost every
        // historical media id is already dead; downloading them would mean
        // thousands of failing requests to save a handful of files. The id is
        // kept in metadata so a later backfill can try if it ever becomes
        // worthwhile.
        metadata: {
          source: "historical_import",
          ...(message.mediaUrl ? { sourceMediaId: message.mediaUrl } : {}),
          ...(message.mimeType ? { mimeType: message.mimeType } : {}),
          ...(message.sourceStatus ? { sourceStatus: message.sourceStatus } : {}),
        },
      },
    });
    return true;
  } catch (err: any) {
    if (err?.code === "P2002") return false;
    throw err;
  }
}

/**
 * The per-customer row the intelligence stages iterate over.
 *
 * Counters are recomputed from the rows that exist rather than incremented,
 * because a chunk can be replayed and an increment would double-count. Slower,
 * and correct under every retry path.
 */
async function upsertHistoricalCustomer(args: {
  importId: string;
  tenantId: string;
  customerExternalId: string;
  conversationId: string;
  messages: HistoricalImportChunkJob["chunk"]["messages"];
  firstAt: Date | null;
  lastAt: Date | null;
}): Promise<void> {
  const { importId, tenantId, customerExternalId, conversationId } = args;

  const [total, inbound, bounds] = await Promise.all([
    prisma.message.count({ where: { conversationId } }),
    prisma.message.count({ where: { conversationId, direction: "INBOUND" } }),
    prisma.message.aggregate({
      where: { conversationId },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
  ]);

  // Meta's history threads carry no profile name - only the number - so the
  // display name comes from whatever the identity stage manages to link this
  // customer to, not from the import payload.
  await prisma.historicalCustomer.upsert({
    where: { importId_externalId: { importId, externalId: customerExternalId } },
    create: {
      importId,
      tenantId,
      externalId: customerExternalId,
      normalizedPhone: normalizePhone(customerExternalId),
      conversationId,
      messageCount: total,
      inboundCount: inbound,
      firstMessageAt: bounds._min.createdAt,
      lastMessageAt: bounds._max.createdAt,
    },
    update: {
      conversationId,
      messageCount: total,
      inboundCount: inbound,
      firstMessageAt: bounds._min.createdAt,
      lastMessageAt: bounds._max.createdAt,
      // A new chunk for a customer whose analysis already ran means the
      // analysis was done on an incomplete history. Reset it so the learning
      // stage picks them up again rather than leaving a summary that silently
      // omits half the conversation.
      learningStatus: "PENDING",
    },
  });
}

/**
 * Look up an existing contact without ever creating one.
 *
 * Contact creation during import is the identity stage's decision, made once
 * per customer with the full picture, not a side effect of whichever chunk
 * happened to arrive first.
 */
async function resolveContactSafely(
  tenantId: string,
  customerExternalId: string,
): Promise<{ displayName: string | null; avatarUrl: string | null } | null> {
  try {
    const { resolveContactByChannelId } = await import("@chatcenter/shared");
    const contact = await resolveContactByChannelId(tenantId, "WHATSAPP", customerExternalId);
    return contact
      ? { displayName: contact.displayName ?? null, avatarUrl: contact.avatarUrl ?? null }
      : null;
  } catch {
    return null;
  }
}

// ─── Shared helpers ──────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

async function transition(
  importId: string,
  status: HistoricalImportStatus,
  data: Record<string, unknown> = {},
): Promise<void> {
  const current = await prisma.historicalImport.findUnique({
    where: { id: importId },
    select: { status: true },
  });
  if (!current) return;
  if (!isForwardTransition(current.status as HistoricalImportStatus, status)) return;
  await prisma.historicalImport.update({
    where: { id: importId },
    data: { status: status as any, ...(data as any) },
  });
}

/**
 * Append-only audit. Counts and safe metadata only - never message bodies,
 * never a customer's phone number. When somebody asks why their history looks
 * short, the answer has to come from what was recorded at the time, and it has
 * to be answerable without reading anybody's correspondence.
 */
export async function recordEvent(
  importId: string,
  step: string,
  outcome: "SUCCESS" | "FAILED" | "SKIPPED" | "PARTIAL",
  message?: string | null,
  detail?: Record<string, unknown>,
  durationMs?: number,
): Promise<void> {
  try {
    await prisma.historicalImportEvent.create({
      data: {
        importId,
        step,
        outcome,
        message: message ?? null,
        detail: (detail ?? undefined) as any,
        durationMs: durationMs ?? null,
      },
    });
  } catch (err: any) {
    // Observability must never be the reason an import fails.
    console.warn(`[historical-import] event write failed: ${err?.message}`);
  }
}
