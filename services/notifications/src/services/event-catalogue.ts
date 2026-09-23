/**
 * The notification event catalogue - what a settings screen may offer.
 *
 * The frontend used to hardcode this list. It now comes from here, so adding a
 * notification in the backend makes it appear in the UI without a frontend
 * change.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY `emitted` IS HAND-MAINTAINED AND NOT COMPUTED
 *
 * It cannot be derived by searching the source, and this is not a matter of
 * writing a better search. Four methods were tried against the same tree:
 *
 *   literal `type: "x"` grep          said  8 events were dead
 *   templated-minus-emitted diff      said  5
 *   emit-call proximity window        said 11
 *   per-event hand verification       said  6   <- the truth
 *
 * Every automated method failed the same way: an event emitted through a
 * VARIABLE is invisible. `classifyToolForNotification()` in ai-bot.service.ts
 * returns an event type and `tryEmit({ type: evt })` fires it ~650 lines away,
 * so `refund.issued`, `discount.applied` and `meeting.scheduled` look dead to
 * any proximity search and are perfectly alive. One method also matched
 * `subscription_canceled` when looking for `subscription.canceled`, because a
 * `.` in a grep pattern is a wildcard.
 *
 * So the list below is verified by hand, and `event-catalogue.test.ts` checks
 * the EVIDENCE rather than recomputing the answer:
 *
 *   emitted: true   the recorded file must still exist and still contain both
 *                   the event key and the symbol that emits it.
 *   emitted: false  NO file outside the declaration set may contain the key.
 *                   Add an emitter and the test fails, forcing this entry to
 *                   be updated - which is the direction that matters, because
 *                   a catalogue that marks a live event dead hides a control
 *                   that works.
 *
 * That is the difference between evidence and a comment. The frontend's old
 * list said "six" too, and was right by luck about the number and wrong about
 * which six - nobody could check it, so it aged into folklore.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { DELIVERABLE_CHANNELS } from "./notification-engine.service";

export interface EmitterRef {
  /** Repo-relative path that performs the emit. */
  file: string;
  /**
   * A symbol that must still be present in that file. For a direct emit this
   * is the emitting call; for an indirect one it is the function that produces
   * the type, which is what makes the indirection checkable at all.
   */
  via: string;
}

export interface CatalogueEntry {
  key: string;
  label: string;
  group: "approvals" | "operations" | "commerce" | "billing" | "system";
  /** Whether anything in the product actually raises this event. */
  emitted: boolean;
  /** Where it is raised. Empty when `emitted` is false. */
  emitters: EmitterRef[];
  /**
   * A sentence the screen must show, verbatim, when one exists.
   *
   * These are not descriptions - each one exists because the obvious reading
   * of the event name is wrong in a way that would mislead a merchant about
   * what the product is doing for them.
   */
  caveat?: string;
}

/**
 * Declaration-only files. A key appearing ONLY in these is defined and never
 * raised - the union that types it, the template that would render it, and the
 * category map. Used by the test to decide whether a "dead" entry is honest.
 */
export const DECLARATION_ONLY_FILES = [
  "services/notifications/src/services/event-emitter.service.ts",
  "services/notifications/src/services/templates.ts",
  "services/ai/src/services/notifications-emit.ts",
  "packages/shared/src/lib/notification-category.ts",
  "services/billing/src/lib/events.ts",
  // This file itself. Naming an event in the catalogue is not emitting it -
  // caught by the test, which counted the catalogue as evidence against its
  // own entries on the first run.
  "services/notifications/src/services/event-catalogue.ts",
] as const;

const E = (file: string, via: string): EmitterRef => ({ file, via });

export const EVENT_CATALOGUE: CatalogueEntry[] = [
  // ── Approvals ──
  {
    key: "tool.approval_required",
    label: "Something needs approval",
    group: "approvals",
    emitted: true,
    emitters: [E("services/notifications/src/services/event-bridge.ts", "tryEmit")],
  },

  // ── Operations ──
  {
    key: "conversation.escalated",
    label: "A conversation was escalated to a person",
    group: "operations",
    emitted: true,
    emitters: [E("services/ai/src/services/ai-bot.service.ts", "tryEmit")],
  },
  {
    key: "conversation.assigned",
    label: "A conversation was assigned to me",
    group: "operations",
    emitted: true,
    emitters: [E("services/conversation/src/services/conversation.service.ts", "publishEvent")],
    caveat:
      "Only when a conversation is reassigned to someone else. Claiming a " +
      "conversation yourself does not notify you.",
  },
  {
    key: "tool.action_failed",
    label: "An action the AI tried to take failed",
    group: "operations",
    emitted: true,
    emitters: [E("services/ai/src/services/ai-bot.service.ts", "tryEmit")],
    caveat:
      "Only when an action broke. An action a rule or a policy refused is the " +
      "product working correctly and is not reported here.",
  },
  {
    key: "integration.check_failed",
    label: "A connected system rejected our credentials",
    group: "operations",
    emitted: true,
    emitters: [E("services/ai/src/routes/integrations.ts", "tryEmit")],
    caveat:
      "Fires when someone runs a connection test and the credentials are " +
      "rejected - not continuous monitoring, and not 'the provider is down'.",
  },
  {
    key: "broadcast.completed",
    label: "A campaign finished sending",
    group: "operations",
    emitted: true,
    emitters: [E("services/outgoing-worker/src/workers/broadcast.worker.ts", "publishEvent")],
    caveat:
      "Finished, not succeeded. Recipients that failed count toward completion, " +
      "so the message states both numbers.",
  },

  // ── Commerce ──
  {
    key: "refund.issued",
    label: "A refund was issued",
    group: "commerce",
    emitted: true,
    // Indirect: the mapper returns the type, tryEmit fires it far below. This
    // is the shape every automated scan got wrong.
    emitters: [E("services/ai/src/services/ai-bot.service.ts", "classifyToolForNotification")],
    caveat: "Only refunds the AI issued through a tool. Refunds made in the store are not seen.",
  },
  {
    key: "discount.applied",
    label: "A discount was applied",
    group: "commerce",
    emitted: true,
    emitters: [E("services/ai/src/services/ai-bot.service.ts", "classifyToolForNotification")],
    caveat: "Only discounts the AI applied through a tool.",
  },
  {
    key: "meeting.scheduled",
    label: "A meeting was booked",
    group: "commerce",
    emitted: true,
    emitters: [E("services/ai/src/services/ai-bot.service.ts", "classifyToolForNotification")],
    caveat: "Only meetings the AI booked through a tool.",
  },

  // ── Billing ──
  ...(
    [
      ["invoice.paid", "An invoice was paid", "services/billing/src/services/invoice.service.ts"],
      ["payment.failed", "A payment failed", "services/billing/src/services/dunning.service.ts"],
      ["subscription.activated", "A subscription became active", "services/billing/src/services/subscription.service.ts"],
      ["subscription.canceled", "A subscription was cancelled", "services/billing/src/services/subscription.service.ts"],
      ["subscription.past_due", "A subscription is past due", "services/billing/src/services/subscription.service.ts"],
      ["subscription.plan_changed", "A subscription plan changed", "services/billing/src/services/subscription.service.ts"],
      ["subscription.resumed", "A subscription resumed", "services/billing/src/services/subscription.service.ts"],
      ["subscription.suspended", "A subscription was suspended", "services/billing/src/services/dunning.service.ts"],
      ["subscription.trial_started", "A trial started", "services/billing/src/services/subscription.service.ts"],
      ["credit.threshold", "AI credit is running low", "services/billing/src/routes/internal.ts"],
      ["credit.exhausted", "AI credit is exhausted", "services/billing/src/routes/internal.ts"],
      ["credit.auto_purchase_succeeded", "Credit was topped up automatically", "services/billing/src/services/purchase.service.ts"],
      ["credit.auto_purchase_failed", "An automatic top-up failed", "services/billing/src/services/purchase.service.ts"],
      ["credit.auto_purchase_ceiling_reached", "The automatic top-up ceiling was reached", "services/billing/src/services/purchase.service.ts"],
    ] as const
  ).map(([key, label, file]): CatalogueEntry => ({
    key,
    label,
    group: "billing",
    emitted: true,
    emitters: [E(file, "emitBillingEvent")],
  })),

  // ── Defined, templated, and raised by NOTHING ──
  //
  // Returned with `emitted: false` rather than omitted, deliberately. A screen
  // that simply hides them cannot explain why a control a merchant remembers
  // has disappeared, and the next person to read the template list will
  // "restore" them. Listed, marked dead, with the reason.
  ...(
    [
      ["high_value_lead.detected", "A high-value lead was detected", "operations"],
      ["lead.created", "A lead was created", "operations"],
      ["system.error.critical", "A critical system error", "system"],
      ["invoice.issued", "An invoice was issued", "billing"],
      ["payment_method.expiring", "A payment method is expiring", "billing"],
      ["subscription.trial_ending", "A trial is ending", "billing"],
    ] as const
  ).map(([key, label, group]): CatalogueEntry => ({
    key,
    label,
    group: group as CatalogueEntry["group"],
    emitted: false,
    emitters: [],
    caveat:
      "Nothing in the product raises this event yet, so a rule for it would " +
      "never run. It is listed so the gap is visible rather than silently absent.",
  })),
];

/**
 * What the endpoint returns. `channels` comes from the dispatcher's own
 * exported constant rather than a list kept here - anything that OFFERS a
 * channel has to agree with what can SEND one, and a second copy is a second
 * chance to offer a box that does nothing.
 */
export function buildCatalogue() {
  return {
    channels: [...DELIVERABLE_CHANNELS],
    events: EVENT_CATALOGUE.map((e) => ({
      key: e.key,
      label: e.label,
      group: e.group,
      emitted: e.emitted,
      caveat: e.caveat ?? null,
    })),
  };
}
