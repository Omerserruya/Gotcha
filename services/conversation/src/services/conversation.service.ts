import { getInternalServiceKey, readDurableSetting, recordHandover, waitingForPersonClause, parseBusinessHours, isWorkspaceDay, dayStart, nextWorkspaceDay } from "@chatcenter/shared";
import { randomUUID } from "crypto";
import { prisma, publishEvent, outgoingMessageQueue, withHistoricalRecords, notificationsQueue } from "@chatcenter/shared";
import { getIO } from "../lib/socket";
import { visibilityClause } from "../lib/conversation-visibility";
import { contactIdsFor, contactIdOf } from "../lib/conversation-contact";
import * as messageService from "./message.service";

/**
 * Keyset pagination for the conversation list.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY NOT OFFSET
 *
 * The list is ordered by recency. With `skip`/`take`, a message arriving between
 * page 1 and page 2 shifts every row down one: the agent sees one conversation
 * twice and **never sees another at all**. A skipped conversation in an inbox is
 * not a cosmetic defect - it is somebody waiting who never appears, and the list
 * looks complete.
 *
 * Deduplicating by id was rejected deliberately: it hides the duplicate and not
 * the skip, so it removes the only visible symptom of the invisible fault.
 *
 * ── The cursor is the sort key, and `lastMessageAt` is NULLABLE ──
 *
 * `(lastMessageAt, id)` with nulls last. The column is a denormalised cache that
 * ~9 message writers never maintained, so historical rows exist with it NULL
 * even though the live paths are fixed now. Nulls sort after every real value,
 * so the cursor carries the literal `"null"` once paging reaches that tail and
 * orders by id alone inside it. Without that, the tail is unreachable and those
 * conversations become the very thing this change exists to prevent.
 * ════════════════════════════════════════════════════════════════════════════
 */
export function encodeConversationCursor(lastMessageAt: Date | null, id: string): string {
  return `${lastMessageAt ? lastMessageAt.toISOString() : "null"}~${id}`;
}

export function decodeConversationCursor(raw: string): { at: Date | null; id: string } | null {
  const sep = raw.indexOf("~");
  if (sep <= 0) return null;
  const head = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!id) return null;
  if (head === "null") return { at: null, id };
  const at = new Date(head);
  if (Number.isNaN(at.getTime())) return null;
  return { at, id };
}

/**
 * "Strictly after this point" in `(lastMessageAt desc nulls last, id desc)`.
 *
 * ★ RETURNED AS A CLAUSE TO PUT IN `AND`, NEVER ASSIGNED TO `where.OR`.
 * `where.OR` on this query already holds the DEPARTMENT/AGENT VISIBILITY clause.
 * Assigning a keyset predicate to it replaces that scoping silently: the list
 * then returns conversations the agent must never see, perfectly ordered, with
 * no error, and the diff reads as pagination.
 */
export function conversationKeysetClause(c: { at: Date | null; id: string }): Record<string, unknown> {
  if (c.at === null) {
    // Already inside the null tail: only id separates rows.
    return { AND: [{ lastMessageAt: null }, { id: { lt: c.id } }] };
  }
  return {
    OR: [
      { lastMessageAt: { lt: c.at } },
      { AND: [{ lastMessageAt: c.at }, { id: { lt: c.id } }] },
      // Nulls sort last, so every null row is after any real timestamp.
      { lastMessageAt: null },
    ],
  };
}

export interface ConversationFilters {
  status?: string;
  assignedAgentId?: string;
  channel?: string;
  departmentId?: string;
  search?: string;
  page?: number;
  limit?: number;
  /** Keyset cursor. When present, `page` is ignored and no total is counted. */
  cursor?: string;
  includeAutomated?: boolean;
  /**
   * Return ONLY the conversations an automation currently owns - the exact
   * complement of the default exclusion below. Powers the inbox's collapsed
   * "handled by AI" section, which is a separate request on purpose: folding
   * these into the main list would let a busy AI crowd the human queues out
   * of the same 50-row page.
   *
   * Wins over `includeAutomated` when both are set, because "only automated"
   * is the narrower, more specific ask.
   */
  automatedOnly?: boolean;
  /**
   * "queue": the inbox's "Waiting in queue" view - exactly the conversations
   * waiting for a person (the shared waitingForPersonClause, the same one Home
   * counts), and `viewTotal` for its header. It used to be the route's default:
   * every status (closed included) and every assignee, so it disagreed with
   * Home (10 vs 9).
   */
  view?: "queue";
  /**
   * A period in the workspace's days (YYYY-MM-DD, `to` inclusive): the
   * conversations STARTED in it, cut at the business-hours time zone's
   * midnight - the same days the Home chat's charts count, so a chart's link
   * opens the same rows. Either end may be omitted.
   */
  from?: string;
  to?: string;
  /** Keyset callers that show a header total ask for it (offset requests always have it). */
  withTotal?: boolean;
  // User context for scoping
  userRole?: string;
  userId?: string;
  userDepartmentId?: string;
}

/** The business-hours time zone: the workspace's days are cut there. */
async function workspaceTimeZone(tenantId: string): Promise<string> {
  try {
    return parseBusinessHours(await readDurableSetting(tenantId, "businessHours"))?.timezone || "UTC";
  } catch {
    return "UTC";
  }
}

/** What "an automation owns this" means, in one place. */
const AUTOMATED_HANDLERS = ["ai_agent", "flow"];

export async function list(tenantId: string, filters: ConversationFilters) {
  const { status, assignedAgentId, channel, departmentId, search, page = 1, limit = 50, cursor, includeAutomated = false, automatedOnly = false, view, from, to, withTotal = false, userRole, userId, userDepartmentId } = filters;
  if ((from !== undefined && !isWorkspaceDay(from)) || (to !== undefined && !isWorkspaceDay(to)) || (from && to && from > to)) {
    throw Object.assign(new Error("invalid_period: from and to are YYYY-MM-DD days, from <= to"), { status: 400 });
  }
  const decodedCursor = cursor ? decodeConversationCursor(cursor) : null;
  if (cursor && !decodedCursor) {
    // Refused by name rather than silently restarting from the top, which a
    // paging UI renders as a list that never ends.
    throw Object.assign(new Error("invalid_cursor"), { status: 400 });
  }
  const keyset = cursor !== undefined;
  const where: any = { tenantId };
  if (view === "queue") {
    // One AND element carrying the whole definition (its own OR inside), so the
    // visibility clause below keeps the top-level OR. Status and the
    // automation rule come from the definition, not from the query.
    const { AND: inner, ...flat } = waitingForPersonClause();
    where.AND = [{ ...flat, ...inner[0] }];
  } else if (status) where.status = status;
  if (view === "queue") {
    // Fully defined above.
  } else if (automatedOnly) {
    // All three conditions are required, and each one alone is wrong:
    // `handledBy` names the driver, `isHandedOver` is the latch a takeover
    // sets, and `assignedAgentId` catches a claim that never flipped the
    // latch. A conversation failing any of them has a human on it and does
    // not belong in a section whose whole promise is "nobody is waiting on
    // you for these".
    where.AND = where.AND || [];
    where.AND.push({
      handledBy: { in: AUTOMATED_HANDLERS },
      isHandedOver: false,
      assignedAgentId: null,
    });
    // The section is a live view, not an archive. Without this a closed AI
    // chat sits in it forever, since the caller passes no status.
    if (!status) where.status = { not: "CLOSED" };
  } else if (!includeAutomated) {
    // By default, exclude AI/flow-handled conversations unless explicitly requested or handed over
    where.AND = where.AND || [];
    where.AND.push({
      OR: [
        { handledBy: null },
        { handledBy: "human" },
        { isHandedOver: true },
      ],
    });
  }
  if (assignedAgentId) where.assignedAgentId = assignedAgentId;
  if (from || to) {
    const tz = await workspaceTimeZone(tenantId);
    where.AND = where.AND || [];
    where.AND.push({ createdAt: { ...(from ? { gte: dayStart(from, tz) } : {}), ...(to ? { lt: dayStart(nextWorkspaceDay(to), tz) } : {}) } });
  }
  if (channel) where.channel = channel;
  if (departmentId) where.departmentId = departmentId;

  // Scope: ADMIN sees all, agents see only unassigned + assigned to them.
  // The rule itself now lives in lib/conversation-visibility.ts so the socket
  // room join asks the identical question - see the header there for the two
  // holes it preserves.
  /**
   * Sandbox rehearsals are not inbox items.
   *
   * ★ IDENTIFIED BY THE `sandbox:` PREFIX, NOT BY `isTest`. The row that exposed
   * this has `is_test = false`, `status = OPEN` and two messages, so an `isTest`
   * filter would not have caught it - and the same confusion has already produced
   * two counting bugs in analytics, where a figure filtered `isTest` and counted
   * every rehearsal as business.
   *
   * Filtering on the thing that is actually true rather than on the thing that
   * sounds like it. Whether `isTest` SHOULD also be set on these rows is a
   * separate question and not folded in here.
   *
   * Pushed into AND, like everything else that is not the visibility clause.
   */
  where.AND = where.AND || [];
  (where.AND as unknown[]).push({ NOT: { customerExternalId: { startsWith: "sandbox:" } } });

  const visibility = visibilityClause({ userId: userId!, role: userRole, departmentId: userDepartmentId });
  if (visibility) where.OR = visibility;

  if (search) {
    where.AND = where.AND || [];
    where.AND.push({
      OR: [
        { customerExternalId: { contains: search, mode: "insensitive" } },
        { customerName: { contains: search, mode: "insensitive" } },
      ],
    });
  }
  /**
   * How many conversations in THIS VIEW have no `lastMessageAt`.
   *
   * ════════════════════════════════════════════════════════════════════════════
   * THE INSTRUMENT FOR THE INVISIBLE HALF
   *
   * ~9 message writers never maintained this column, so a conversation can carry
   * a stale or absent sort key and drift down the queue while somebody waits.
   * Two properties make a count the only honest answer:
   *
   *   · nulls sort LAST, so the undated rows sit at the very end of the queue.
   *     Any group rendered from a page is empty on every page but the last, and
   *     empty entirely on a capped list - so the instrument for the problem is
   *     invisible for exactly the tenants large enough to have it.
   *   · a number does not require loading the whole queue to obtain.
   *
   * ★ SCOPED TO THE VIEW, NOT TO THE PAGE. It reuses the caller's filters
   * INCLUDING the visibility clause - a count that ignored visibility would
   * report a figure about conversations this agent may not see. And it is built
   * BEFORE the keyset predicate is pushed, because "how many are undated in this
   * view" must not change as somebody scrolls.
   *
   * Cost: one extra `count` per list request, narrow (`lastMessageAt IS NULL`)
   * and on the same filters. Deliberate - the total we dropped was a full scan
   * for a figure nobody asked for; this is a small one for a figure that is the
   * only way to tell "we fixed it" from "we stopped looking".
   * ════════════════════════════════════════════════════════════════════════════
   */
  // The view's own total, for its header (the queue, "All conversations", a
  // status, an assignee, automatedOnly, a period, a channel): same filters and
  // visibility as the rows, before the cursor, like undatedWhere. Without it a
  // keyset page's header could only print the page (the Home chat counted 81
  // for September, the inbox said 50). Offset requests already count `total`
  // on these filters, so it is reused; a keyset request counts only when asked
  // (`withTotal`, or the queue view), so scrolling pays no full scan nobody reads.
  const viewWhere = keyset && (view === "queue" || withTotal) ? { ...where, AND: [...((where.AND as unknown[]) ?? [])] } : null;
  const undatedWhere = {
    ...where,
    // A fresh array: `where.AND` is about to be mutated by the push below, and
    // sharing it would let the cursor leak into a count that must not see it.
    AND: [...((where.AND as unknown[]) ?? [])],
    lastMessageAt: null,
  };

  // ★ ADDITIVE. `where.OR` is the visibility clause - see
  // conversationKeysetClause's note. `search` above already pushes its own
  // `{ OR: [...] }` into AND, which is the shape to copy.
  if (decodedCursor) {
    where.AND = where.AND || [];
    where.AND.push(conversationKeysetClause(decodedCursor));
  }

  const include = {
    assignedAgent: { select: { id: true, name: true, email: true } },
    department: { select: { id: true, name: true } },
    _count: { select: { messages: true } },
    /**
     * ★ THE LAST MESSAGE, NOT THE LAST ROW.
     *
     * A FAILED outbound is a message the customer never received, and taking it
     * as the conversation's last message broke the inbox in two ways at once:
     *
     *  - `lastMessageDirection` came back OUTBOUND, and the list's `isUnread`
     *    returns false for anything not INBOUND. So a customer whose question
     *    the bot failed to answer STOPPED SHOWING AS UNREAD - the row went
     *    quiet at the exact moment it needed attention.
     *  - `lastMessageBody` previewed text that was never delivered, so the row
     *    read as answered.
     *
     * The same rule already governs `lastMessageAt` (a failed send does not
     * advance the sort key). Without it here the two disagreed: the column
     * skipped the failed row and this projection did not, which is worse than
     * either behaviour on its own.
     *
     * The thread itself is unaffected - `listByConversation` still returns the
     * failed message, because the AGENT does need to see that a send failed.
     * It is only the summary of what the CUSTOMER has seen that excludes it.
     */
    messages: {
      where: { status: { not: "FAILED" as const } },
      orderBy: { createdAt: "desc" as const },
      take: 1,
      // messageType lets the row say "Photo" / "Voice message" instead of the
      // adapter's "[Image]" filler (2026-10-09). metadata is NOT selected: a
      // nested take is applied in memory, so it would load every message's JSON.
      select: { direction: true, body: true, createdAt: true, messageType: true },
    },
  };
  // id breaks ties so two conversations sharing a millisecond cannot straddle a
  // page boundary and reproduce the skip in a rarer form.
  const orderBy = [
    { lastMessageAt: { sort: "desc" as const, nulls: "last" as const } },
    { id: "desc" as const },
  ];

  // Keyset takes `limit + 1` to learn whether more exist, and counts NO total:
  // a keyset list cannot page to a known end, and the count was a second full
  // scan for a figure the caller does not need.
  const [conversations, total, undatedCount, viewTotal] = await Promise.all([
    prisma.conversation.findMany({
      where,
      include,
      orderBy,
      take: keyset ? limit + 1 : limit,
      ...(keyset ? {} : { skip: (page - 1) * limit }),
    }),
    keyset ? Promise.resolve(null) : prisma.conversation.count({ where }),
    prisma.conversation.count({ where: undatedWhere }),
    viewWhere ? prisma.conversation.count({ where: viewWhere }) : Promise.resolve(null),
  ]);
  const hasMore = keyset && conversations.length > limit;
  const pageRows = hasMore ? conversations.slice(0, limit) : conversations;

  // Flatten last message info, and the contact behind each row (one batched,
  // read-only lookup for the page - see lib/conversation-contact.ts).
  const rows = keyset ? pageRows : conversations;
  const contactMap = await contactIdsFor(tenantId, rows as any[]);
  const data = rows.map((c) => {
    const lastMsg = c.messages[0] || null;
    const { messages, ...rest } = c;
    return {
      ...rest,
      contactId: contactIdOf(contactMap, c as any),
      lastMessageDirection: lastMsg?.direction || null,
      lastMessageBody: lastMsg?.body || null,
      lastMessageType: lastMsg?.messageType ?? null,
    };
  });

  if (keyset) {
    const last = pageRows[pageRows.length - 1];
    return {
      data,
      page: {
        limit,
        hasMore: !!hasMore,
        nextCursor: hasMore && last ? encodeConversationCursor(last.lastMessageAt, last.id) : null,
      },
      // For the whole view, not this page. See undatedWhere above.
      undatedCount,
      ...(viewTotal !== null ? { viewTotal } : {}),
    };
  }
  // Legacy offset callers keep the exact shape they had, total included.
  const t = total as number;
  return { data, meta: { total: t, page, limit, totalPages: Math.ceil(t / limit) }, undatedCount, viewTotal: t };
}

export async function getById(tenantId: string, id: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id, tenantId },
    include: {
      assignedAgent: { select: { id: true, name: true, email: true } },
      department: { select: { id: true, name: true } },
      channelAccount: { select: { id: true, channel: true, displayName: true, externalId: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!conversation) return null;
  const contactMap = await contactIdsFor(tenantId, [conversation as any]);
  return { ...conversation, contactId: contactIdOf(contactMap, conversation as any) };
}

/** The customer and channel an assignment notice names ("the conversation with Dana on WhatsApp"). */
function whoAndWhere(c: { customerName?: string | null; customerExternalId?: string | null; channel?: unknown }) {
  return { customerName: c.customerName || c.customerExternalId || null, channel: c.channel ? String(c.channel) : null };
}

export async function transferToDepartment(tenantId: string, conversationId: string, departmentId: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });

  const department = await prisma.department.findFirst({
    where: { id: departmentId, tenantId, isActive: true },
    include: { members: { include: { user: { select: { id: true, name: true, isActive: true, _count: { select: { conversations: { where: { status: { not: "CLOSED" } } } } } } } } } },
  });
  if (!department) throw Object.assign(new Error("Department not found"), { status: 404 });

  let assignedAgentId: string | null = null;

  // If round-robin, assign to the agent with fewest active conversations
  if (department.queueMode === "ROUND_ROBIN") {
    const activeMembers = department.members.filter((m) => m.user.isActive);
    if (activeMembers.length > 0) {
      activeMembers.sort((a, b) => a.user._count.conversations - b.user._count.conversations);
      assignedAgentId = activeMembers[0].userId;
    }
  }

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      departmentId,
      assignedAgentId,
      isHandedOver: true,
      status: assignedAgentId ? "OPEN" : "WAITING",
    },
    include: {
      assignedAgent: { select: { id: true, name: true, email: true } },
      department: { select: { id: true, name: true } },
    },
  });

  const agentName = updated.assignedAgent?.name;
  await createSystemMessage(tenantId, conversationId, "department_transferred", {
    departmentName: department.name,
    ...(agentName ? { agentName } : {}),
  });

  emitToTenant(tenantId, "conversation:updated", updated);

  // Keyed on assignedAgentId being non-null, NOT on queueMode. A ROUND_ROBIN
  // department with no active members leaves this null and the conversation
  // WAITING - there is nobody to tell. That is the same fact the status one
  // line above keys off, so the two cannot disagree.
  //
  // This is the case that most needs telling: with a reassign a person chose
  // you and usually says so, while here the system picked you by lowest
  // workload and nobody is on the other end of it.
  //
  // Cannot double-fire with reassign(): the only callers are the two branches
  // of one if/else in routes/conversations.ts, so a request takes exactly one.
  if (assignedAgentId) {
    notificationsQueue
      .add(
        "system-event",
        {
          id: randomUUID(),
          type: "conversation.assigned",
          tenantId,
          data: { conversationId, departmentName: department.name, assignedToName: agentName ?? null, ...whoAndWhere(conversation) },
          metadata: { conversationId, userId: assignedAgentId, timestamp: new Date().toISOString() },
        },
        { removeOnComplete: 1000, removeOnFail: 100, attempts: 5, backoff: { type: "exponential", delay: 2_000 } },
      )
      .catch((err: any) => console.warn("[conversation] department assignment notify failed:", err?.message ?? err));
  }

  // Auto-greeting if agent was auto-assigned via round-robin
  if (assignedAgentId) {
    await sendAutoGreeting(tenantId, conversationId, assignedAgentId, conversation);
  }

  return updated;
}

export async function claim(tenantId: string, conversationId: string, agentId: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });

  // Allow reclaim if already assigned to the same agent (e.g. after transfer)
  if (conversation.assignedAgentId && conversation.assignedAgentId !== agentId) {
    throw Object.assign(new Error("Conversation already assigned"), { status: 409 });
  }

  const alreadyAssigned = conversation.assignedAgentId === agentId;

  const updated = alreadyAssigned
    ? await prisma.conversation.findFirst({
        where: { id: conversationId, tenantId },
        include: { assignedAgent: { select: { id: true, name: true, email: true } } },
      })
    : await prisma.conversation.update({
        where: { id: conversationId },
        data: { assignedAgentId: agentId, isHandedOver: true },
        include: { assignedAgent: { select: { id: true, name: true, email: true } } },
      });

  if (!updated) throw Object.assign(new Error("Conversation not found"), { status: 404 });

  if (!alreadyAssigned) {
    // System divider: agent claimed
    const agentName = updated.assignedAgent?.name || "Agent";
    await createSystemMessage(tenantId, conversationId, "agent_claimed", { agentName });
  }

  emitToTenant(tenantId, "conversation:updated", updated);

  // Auto-greeting (send on both claim and reclaim)
  await sendAutoGreeting(tenantId, conversationId, agentId, conversation);

  return updated;
}

export async function release(tenantId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { assignedAgentId: null, status: "OPEN" },
    include: { assignedAgent: { select: { id: true, name: true, email: true } } },
  });

  emitToTenant(tenantId, "conversation:updated", updated);
  return updated;
}

/**
 * Hand a human-owned conversation BACK to the AI employee. The inverse of
 * escalation/claim: clears the human assignment AND the isHandedOver latch
 * (which nothing else in the system ever clears), so the bot resumes on the
 * next inbound. Requires an AI employee to actually be bound to the
 * conversation - otherwise there is nobody to hand back to.
 */
export async function returnToAi(tenantId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });
  if (!(conversation as any).assignedAiAgentId) {
    throw Object.assign(new Error("No AI employee is bound to this conversation"), { status: 409 });
  }

  await recordHandover({
    tenantId,
    conversationId,
    to: "ai_agent",
    reason: "return_to_ai",
    data: { assignedAgentId: null, isHandedOver: false, status: "OPEN" },
  });
  const updated = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    include: { assignedAgent: { select: { id: true, name: true, email: true } } },
  });

  await createSystemMessage(tenantId, conversationId, "returned_to_ai", {});
  emitToTenant(tenantId, "conversation:updated", updated);
  return updated;
}

/**
 * Stop the AI on a conversation WITHOUT assigning it to anyone - the inverse of
 * returnToAi. Sets the isHandedOver latch the bot already respects
 * (ai-bot.service and the incoming worker skip a handed-over conversation), so
 * the next inbound waits for a person instead of getting an AI reply. Nobody is
 * assigned: the conversation stays in the shared queue for whoever picks it up.
 * returnToAi undoes it.
 */
export async function stopAi(tenantId: string, conversationId: string, actorUserId?: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });

  await recordHandover({
    tenantId,
    conversationId,
    to: "human",
    actorUserId,
    reason: "ai_stopped",
    data: { isHandedOver: true },
  });
  const updated = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    include: { assignedAgent: { select: { id: true, name: true, email: true } } },
  });

  await createSystemMessage(tenantId, conversationId, "ai_stopped", {});
  emitToTenant(tenantId, "conversation:updated", updated);
  return updated;
}

/**
 * `actorUserId` is the person who moved it; without one it was GOTCHA (an AI
 * or an automation). The notification names the ACTOR: it used to name the
 * previous assignee ("Unknown" when there was none), so "X assigned you a
 * conversation" could name someone who did nothing.
 */
export async function reassign(tenantId: string, conversationId: string, newAgentId: string, actorUserId?: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { assignedAgent: { select: { name: true } } },
  });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });
  const newAgent = await prisma.user.findFirst({ where: { id: newAgentId, tenantId } });
  if (!newAgent) throw Object.assign(new Error("Agent not found"), { status: 404 });

  const fromAgentName = (conversation as any).assignedAgent?.name || "Unknown";
  const toAgentName = newAgent.name;

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { assignedAgentId: newAgentId, isHandedOver: true },
    include: { assignedAgent: { select: { id: true, name: true, email: true } } },
  });

  // System divider: conversation transferred
  await createSystemMessage(tenantId, conversationId, "agent_transferred", { fromAgentName, toAgentName });

  // Screen 15's "a conversation is assigned to me". ONLY here: the other
  // writers of assignedAgentId are self-claims (a user picking up their own
  // conversation), and telling someone they claimed the thing they just
  // clicked is the noise that screen exists to prevent. `userId` carries the
  // recipient, so the dispatcher can address the person assigned rather than
  // the tenant. Fire-and-forget - a notification outage must not undo a
  // transfer that has already happened.
  // Nobody is told they assigned something to themselves. A failed name
  // lookup must not fail a transfer that has already happened.
  const actor = actorUserId
    ? await prisma.user.findFirst({ where: { id: actorUserId, tenantId }, select: { name: true } }).catch(() => null)
    : null;
  const assignedByName = actorUserId ? (actor?.name ?? null) : "GOTCHA";
  if (actorUserId !== newAgentId) notificationsQueue
    .add(
      "system-event",
      {
        id: randomUUID(),
        type: "conversation.assigned",
        tenantId,
        data: { conversationId, assignedByName, assignedToName: toAgentName, ...whoAndWhere(conversation) },
        metadata: { conversationId, userId: newAgentId, timestamp: new Date().toISOString() },
      },
      { removeOnComplete: 1000, removeOnFail: 100, attempts: 5, backoff: { type: "exponential", delay: 2_000 } },
    )
    .catch((err: any) => console.warn("[conversation] assignment notify failed:", err?.message ?? err));

  emitToTenant(tenantId, "conversation:updated", updated);

  // Auto-greeting from the new agent
  await sendAutoGreeting(tenantId, conversationId, newAgentId, conversation);

  return updated;
}

export async function close(tenantId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: "CLOSED", closedAt: new Date() },
    include: { assignedAgent: { select: { id: true, name: true, email: true } } },
  });

  emitToTenant(tenantId, "conversation:closed", updated);
  return updated;
}

export async function getAgentWorkload(tenantId: string) {
  const agents = await prisma.user.findMany({
    where: { tenantId, role: "AGENT", isActive: true },
    select: {
      id: true, name: true, email: true,
      _count: { select: { conversations: { where: { status: { not: "CLOSED" } } } } },
    },
  });
  return agents.map((a) => ({ agentId: a.id, name: a.name, email: a.email, activeCount: a._count.conversations }));
}

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";
const INTERNAL_SERVICE_KEY = getInternalServiceKey();

/**
 * Ask the AI service for the CRM-side identifiers (phone, email, every
 * GOTCHA-prefixed channel id custom field - gotcha_psid_instagram,
 * gotcha_wa_id, etc.) tied to this conversation's linked Lead/Contact. The
 * CRM is authoritative - local Contact rows can be sparse or missing for
 * some channels - so the History walk uses these to find every
 * conversation across every channel for the same person.
 *
 * Returns null on any failure; the caller falls back to local-only matching.
 */
async function fetchCrmIdentifiersForConversation(
  tenantId: string,
  conversationId: string,
): Promise<{ phone: string | null; email: string | null; channelExternalIds: Record<string, string> } | null> {
  try {
    const url = `${AI_SERVICE_URL.replace(/\/$/, "")}/api/crm/resolve-identifiers`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify({ tenantId, conversationId }),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as any;
    if (!data) return null;
    return {
      phone: data.phone ?? null,
      email: data.email ?? null,
      channelExternalIds: (data.channelExternalIds ?? {}) as Record<string, string>,
    };
  } catch {
    return null;
  }
}

export async function getHistoryByCustomerExternalId(
  tenantId: string,
  customerExternalId: string,
  conversationId?: string,
  /** The viewer. Their visibility applies, as in the list: a department-
   *  restricted agent does not get another department's threads (and their
   *  last message) through a customer's history. */
  viewer?: { userId: string; role?: string; departmentId?: string },
) {
  // Cross-platform history walk. The bare (tenantId, customerExternalId) lookup
  // only finds same-channel conversations (Instagram PSID matches the PSID,
  // phone matches the phone, etc.). To surface ALL prior conversations for
  // this person - WhatsApp + Instagram + Messenger + voice + … - we follow
  // two unification keys:
  //   1. Contact.personId    - populated by unifyContact when rows share an
  //                            email/phone, so platform contacts on different
  //                            channels collapse to a single person.
  //   2. Contact.metadata.crmContactId - the auto-link pointer that bridges
  //                            inbound conversations to the same CRM Lead/
  //                            Contact across every channel.
  //
  // We start from any Contact row matching the inbound externalId, gather
  // the union of all externalIds that share its personId or crmContactId,
  // then pull every conversation for those externalIds. The original
  // externalId is included so conversations without a Contact pointer still
  // appear.

  const seedContacts = await prisma.contact.findMany({
    where: { tenantId, externalId: customerExternalId },
    select: { id: true, personId: true, metadata: true, phone: true, email: true },
  });

  const externalIds = new Set<string>([customerExternalId]);
  const personIds = new Set<string>();
  const crmContactIds = new Set<string>();
  const phones = new Set<string>();
  const emails = new Set<string>();
  for (const c of seedContacts) {
    if (c.personId) personIds.add(c.personId);
    if (c.phone) phones.add(c.phone);
    if (c.email) emails.add(c.email.toLowerCase());
    const meta = (c.metadata as Record<string, unknown> | null) ?? {};
    const crmId = typeof meta.crmContactId === "string" ? meta.crmContactId : null;
    if (crmId) crmContactIds.add(crmId);
  }

  // Pull the CRM-side identifiers - the CRM is the source of truth for
  // phone/email and gotcha_psid_* custom fields. Local Contact rows can be
  // sparse or missing on some channels; this fills the gaps.
  if (conversationId) {
    const crmIdent = await fetchCrmIdentifiersForConversation(tenantId, conversationId);
    if (crmIdent) {
      if (crmIdent.phone) phones.add(crmIdent.phone);
      if (crmIdent.email) emails.add(crmIdent.email.toLowerCase());
      // Every channel custom field is a candidate externalId for that channel's
      // conversations (PSID for IG, page-id for Messenger, WA id for WhatsApp, etc.)
      for (const id of Object.values(crmIdent.channelExternalIds)) {
        if (id) externalIds.add(id);
      }
    }
  }

  if (personIds.size > 0 || crmContactIds.size > 0 || phones.size > 0 || emails.size > 0) {
    const siblingFilters: any[] = [];
    if (personIds.size > 0) siblingFilters.push({ personId: { in: Array.from(personIds) } });
    if (phones.size > 0) siblingFilters.push({ phone: { in: Array.from(phones) } });
    if (emails.size > 0) {
      // Email matches are normalized lowercase. Contact.email is stored as
      // the user provided it; case-insensitive `in` via Prisma needs `mode`,
      // but our writers already lowercase, so an `in` against lowered set
      // matches in practice. Also add a raw exact match as a safety net.
      siblingFilters.push({ email: { in: Array.from(emails) } });
    }
    // Prisma's path filter on Json works for Postgres - `path: ["crmContactId"]`
    // matches the same key our auto-link writes.
    for (const id of crmContactIds) {
      siblingFilters.push({ metadata: { path: ["crmContactId"], equals: id } });
    }
    // Also pull externalIds that LITERALLY match the phone (Meta WhatsApp
    // stores the customerExternalId AS the phone digits - no `+`). Trying
    // both formats covers tenants that normalize to E.164 and tenants on
    // legacy local format.
    for (const p of phones) {
      const digits = p.replace(/\D/g, "");
      externalIds.add(p);
      if (digits) externalIds.add(digits);
    }
    const siblings = await prisma.contact.findMany({
      where: { tenantId, OR: siblingFilters },
      select: { externalId: true },
    });
    for (const s of siblings) {
      if (s.externalId) externalIds.add(s.externalId);
    }
  }

  // Imported history belongs HERE and nowhere else.
  //
  // `origin: LIVE` is injected into every conversation query by default, which
  // is what keeps a WhatsApp history import out of the inbox, the unread
  // counts and the routing. But this endpoint answers exactly one question -
  // "what happened with this person before?" - and answering it while hiding
  // the conversations we imported for that purpose made the whole import
  // invisible: 7,986 messages in the database and an empty History panel.
  //
  // So this one call site opts in deliberately, and every row carries its
  // `origin` onward so the panel can label imported threads rather than
  // passing them off as conversations that happened in GOTCHA.
  const historyVisibility = viewer ? visibilityClause(viewer) : null;
  const conversations = await withHistoricalRecords(() =>
    prisma.conversation.findMany({
      where: {
        tenantId,
        customerExternalId: { in: Array.from(externalIds) },
        ...(historyVisibility ? { OR: historyVisibility } : {}),
      },
      include: {
        assignedAgent: { select: { id: true, name: true } },
        _count: { select: { messages: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1, select: { direction: true, body: true, createdAt: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return conversations.map((c) => {
    const lastMsg = c.messages[0] || null;
    const { messages, ...rest } = c;
    return {
      ...rest,
      lastMessageBody: lastMsg?.body || null,
      lastMessageDirection: lastMsg?.direction || null,
      /** RecordOrigin: "LIVE" or "HISTORICAL_IMPORT". The panel marks the imported ones. */
      origin: (c as { origin?: string }).origin ?? "LIVE",
    };
  });
}

function emitToTenant(tenantId: string, event: string, data: any) {
  try { getIO().to(`tenant:${tenantId}`).emit(event, data); } catch {}
  publishEvent({ event, tenantId, data }).catch(() => {});
}

// ─── System divider messages ────────────────────────────────

async function createSystemMessage(
  tenantId: string,
  conversationId: string,
  systemEvent: string,
  eventData: Record<string, string>,
) {
  try {
    await messageService.create({
      tenantId,
      conversationId,
      direction: "INBOUND",
      body: "",
      messageType: "system",
      senderName: "System",
      metadata: { systemEvent, ...eventData },
    });
  } catch (err) {
    console.error("System message error (non-fatal):", err);
  }
}

// ─── Auto-greeting helper (channel-aware) ───────────────────

async function sendAutoGreeting(
  tenantId: string,
  conversationId: string,
  agentId: string,
  conversation: any,
) {
  try {
    const { getRedis } = await import("@chatcenter/shared");
    const redis = getRedis();
    const template = await readDurableSetting(tenantId, "autoGreeting");
    if (!template) return;

    const agent = await prisma.user.findUnique({ where: { id: agentId }, select: { name: true } });
    const greeting = template.replace(/\{agentName\}/g, agent?.name || "Agent");

    const channel = conversation.channel || "WHATSAPP";
    const recipientId = conversation.customerExternalId;
    let channelAccountId: string | null = conversation.channelAccountId;

    // If no channelAccountId on conversation, try to find one for this tenant+channel
    if (!channelAccountId) {
      const fallbackAccount = await prisma.channelAccount.findFirst({
        where: { tenantId, channel, isActive: true },
        select: { id: true },
      });
      if (fallbackAccount) channelAccountId = fallbackAccount.id;
    }

    if (!channelAccountId) return;

    const message = await messageService.create({
      tenantId,
      conversationId,
      direction: "OUTBOUND",
      body: greeting,
      senderName: agent?.name || "System",
    });

    await outgoingMessageQueue.add("send", {
      tenantId,
      conversationId,
      channel,
      channelAccountId,
      recipientExternalId: recipientId,
      body: greeting,
      messageType: "text",
      senderName: agent?.name || "System",
      messageId: message.id,
    }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
  } catch (err) {
    console.error("Auto-greeting error (non-fatal):", err);
  }
}
