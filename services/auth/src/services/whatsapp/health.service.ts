/**
 * Per-number health and auto-repair.
 *
 * Phase 10. Two rules shape everything here:
 *
 *  1. **Health is per number.** Checking, reporting and repairing one number
 *     must never touch another. The blast radius of every function below is
 *     one `WhatsAppNumber` row and the Meta assets that number alone depends
 *     on. The single case where that is not naturally true - webhook
 *     subscription, which Meta scopes to the WABA rather than the number - is
 *     handled explicitly in `disconnectNumber`.
 *
 *  2. **Honesty over reassurance.** A number is reported healthy only when we
 *     have current evidence for every claim. "Webhooks active" means we read
 *     the subscription back from Meta, not that a POST returned 200 once.
 *
 * When something is wrong the customer gets the exact reason, Meta's own
 * response, and a repair button only when repair is actually possible.
 */

import {
  prisma,
  decryptCredentials,
  getRedis,
  MetaWhatsAppClient,
  type MetaHealthStatus,
} from "@chatcenter/shared";
import type { WhatsAppNumber, WhatsAppNumberState } from "@prisma/client";
import { checkNumberHealth } from "./onboarding.service";

// ─── Reported shape ──────────────────────────────────────────

/** One line item on the number's health card. */
export interface HealthCheck {
  id: "CONNECTED" | "MESSAGING" | "WEBHOOKS" | "VERIFICATION" | "QUALITY";
  label: string;
  status: "PASS" | "WARN" | "FAIL" | "UNKNOWN";
  /** Plain sentence. Shown under the label when not PASS. */
  detail?: string;
  /** Meta's own remediation text, verbatim. Never rewritten. */
  metaSolution?: string;
  metaErrorCode?: number;
}

export type RepairAction =
  /** Re-subscribe our app to the WABA's webhooks. */
  | "RESUBSCRIBE_WEBHOOKS"
  /** Re-read every field from Meta and refresh the stored snapshot. */
  | "REFRESH_STATUS";

export interface NumberHealthReport {
  numberId: string;
  phoneNumberId: string;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
  state: WhatsAppNumberState;
  /** Overall verdict, derived from the checks below rather than stored. */
  ready: boolean;
  checks: HealthCheck[];
  /** Repairs we can genuinely perform. Empty when there is nothing to try. */
  availableRepairs: RepairAction[];
  /**
   * Problems only the customer can resolve. Separated from `availableRepairs`
   * so the UI never offers a button that cannot work; offering one and having
   * it fail is worse than saying plainly that this one is theirs to fix.
   */
  customerActions: HealthCheck[];
  lastCheckedAt?: Date | null;
  /** Meta's raw health response. Rendered as-is in the details panel. */
  healthSnapshot?: MetaHealthStatus | null;
}

// ─── Client construction ─────────────────────────────────────

/**
 * Build a Meta client from the number's own stored token.
 *
 * Reads `ChannelAccount.credentials`, which is per number by design (see
 * onboarding.service `upsertNumberRecord`). So a health check for one number
 * cannot be affected by, or affect, another number's credentials.
 */
async function clientForNumber(
  number: WhatsAppNumber,
): Promise<MetaWhatsAppClient | null> {
  const channel = await prisma.channelAccount.findUnique({
    where: { id: number.channelAccountId },
    select: { credentials: true },
  });
  if (!channel) return null;
  try {
    const creds = decryptCredentials(channel.credentials as any);
    const token = creds?.accessToken;
    if (typeof token !== "string" || !token) return null;
    return new MetaWhatsAppClient({ accessToken: token });
  } catch {
    // A credential blob we cannot decrypt is a real, reportable condition, not
    // something to crash the health page over.
    return null;
  }
}

// ─── Reporting ───────────────────────────────────────────────

function healthEntitiesToChecks(health: MetaHealthStatus | null | undefined): HealthCheck[] {
  if (!health?.entities) return [];
  const out: HealthCheck[] = [];
  for (const entity of health.entities) {
    if (entity.can_send_message === "AVAILABLE") continue;
    for (const err of entity.errors || []) {
      out.push({
        id: "MESSAGING",
        label: entityLabel(entity.entity_type),
        status: entity.can_send_message === "BLOCKED" ? "FAIL" : "WARN",
        detail: err.error_description,
        metaSolution: err.possible_solution,
        metaErrorCode: err.error_code,
      });
    }
  }
  return out;
}

function entityLabel(type?: string): string {
  switch (type) {
    case "BUSINESS":
      return "Business verification";
    case "PHONE_NUMBER":
      return "Phone number";
    case "MESSAGE_TEMPLATE":
      return "Message templates";
    case "WABA":
      return "WhatsApp account";
    default:
      return "WhatsApp";
  }
}

/**
 * Build the report from what is already stored.
 *
 * Deliberately does NOT call Meta: the numbers list renders many of these at
 * once, and a page that fans out one Graph request per number per render would
 * be slow and would burn the customer's rate budget for no new information.
 * `refreshNumberHealth` is the explicit "go and look again" path.
 */
export function buildHealthReport(number: WhatsAppNumber): NumberHealthReport {
  const checks: HealthCheck[] = [];
  const health = (number.healthSnapshot as MetaHealthStatus | null) ?? null;

  // 1. Connected
  checks.push({
    id: "CONNECTED",
    label: "Connected to WhatsApp",
    status:
      number.state === "CONNECTED" || number.state === "DEGRADED"
        ? "PASS"
        : number.state === "DISCONNECTED"
          ? "FAIL"
          : "WARN",
    detail:
      number.state === "ACTION_REQUIRED"
        ? "Waiting for you to finish one step."
        : number.state === "FAILED"
          ? number.lastError || "Setup did not finish."
          : undefined,
  });

  // 2. Messaging, straight from Meta's own verdict
  const canSend = number.canSendMessage;
  checks.push({
    id: "MESSAGING",
    label: "Messaging enabled",
    status:
      canSend === "AVAILABLE"
        ? "PASS"
        : canSend === "LIMITED"
          ? "WARN"
          : canSend === "BLOCKED"
            ? "FAIL"
            : "UNKNOWN",
    detail:
      canSend === "LIMITED"
        ? "WhatsApp is limiting how many messages this number can send."
        : canSend === "BLOCKED"
          ? "WhatsApp is blocking this number from sending messages."
          : canSend == null
            ? "Not checked yet."
            : undefined,
  });

  // 3. Webhooks. The load-bearing one: without it nothing arrives, however
  // healthy everything else looks.
  checks.push({
    id: "WEBHOOKS",
    label: "Receiving incoming messages",
    status: number.webhookSubscribed ? "PASS" : "FAIL",
    detail: number.webhookSubscribed
      ? undefined
      : number.webhookOverrideUri
        ? "Another platform is currently receiving this number's messages."
        : "Incoming messages are not being delivered to GOTCHA.",
  });

  // 4. Verification
  checks.push({
    id: "VERIFICATION",
    label: "Number verified",
    status:
      number.codeVerificationStatus === "VERIFIED"
        ? "PASS"
        : number.codeVerificationStatus == null
          ? "UNKNOWN"
          : "FAIL",
    detail:
      number.codeVerificationStatus === "EXPIRED"
        ? "The verification on this number has expired and needs redoing."
        : number.codeVerificationStatus === "NOT_VERIFIED"
          ? "This number has not been verified with WhatsApp yet."
          : undefined,
  });

  // 5. Quality. Never a FAIL on its own: a RED rating is a warning about
  // customer behaviour, not a broken connection, and showing it as a failure
  // would send people hunting for a technical fault that does not exist.
  checks.push({
    id: "QUALITY",
    label: "Quality rating",
    status:
      number.qualityRating === "GREEN"
        ? "PASS"
        : number.qualityRating === "RED" || number.qualityRating === "YELLOW"
          ? "WARN"
          : "UNKNOWN",
    detail:
      number.qualityRating === "RED"
        ? "Recipients have been blocking or reporting messages from this number. WhatsApp may limit it."
        : number.qualityRating === "YELLOW"
          ? "Message quality has dipped. Keep an eye on it."
          : undefined,
  });

  checks.push(...healthEntitiesToChecks(health));

  const customerActions = checks.filter(
    (c) => c.status !== "PASS" && (c.metaSolution != null || c.id === "VERIFICATION"),
  );

  const availableRepairs: RepairAction[] = [];
  if (!number.webhookSubscribed && !number.webhookOverrideUri) {
    availableRepairs.push("RESUBSCRIBE_WEBHOOKS");
  }
  availableRepairs.push("REFRESH_STATUS");

  const ready =
    number.state === "CONNECTED" &&
    number.webhookSubscribed &&
    canSend !== "BLOCKED";

  return {
    numberId: number.id,
    phoneNumberId: number.phoneNumberId,
    displayPhoneNumber: number.displayPhoneNumber,
    verifiedName: number.verifiedName,
    state: number.state,
    ready,
    checks,
    availableRepairs,
    customerActions,
    lastCheckedAt: number.lastHealthCheck,
    healthSnapshot: health,
  };
}

/**
 * Go and look again: re-read every field and Meta's health for ONE number.
 *
 * Also re-derives the number's state, so a number that recovered on Meta's side
 * stops being reported as degraded without anyone having to press repair.
 */
export async function refreshNumberHealth(numberId: string): Promise<NumberHealthReport | null> {
  const number = await prisma.whatsAppNumber.findUnique({ where: { id: numberId } });
  if (!number) return null;

  const client = await clientForNumber(number);
  if (!client) {
    await prisma.whatsAppNumber.update({
      where: { id: numberId },
      data: {
        state: "DEGRADED",
        lastError: "GOTCHA's access to this number needs renewing. Reconnect it.",
        lastHealthCheck: new Date(),
      },
    });
    const reloaded = await prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: numberId } });
    return buildHealthReport(reloaded);
  }

  // Number fields
  const phone = await client.getPhoneNumber(number.phoneNumberId);
  if (phone.ok) {
    const p = phone.value;
    await prisma.whatsAppNumber.update({
      where: { id: numberId },
      data: {
        displayPhoneNumber: p.display_phone_number ?? undefined,
        verifiedName: p.verified_name ?? undefined,
        platformType: p.platform_type ?? undefined,
        isOnBizApp: p.is_on_biz_app === true,
        messagingStatus: p.status ?? undefined,
        codeVerificationStatus: p.code_verification_status ?? undefined,
        nameStatus: p.name_status ?? undefined,
        qualityRating: p.quality_rating ?? undefined,
        throughputLevel: p.throughput?.level ?? undefined,
        messagingLimitTier: p.messaging_limit_tier ?? undefined,
        webhookOverrideUri: p.webhook_configuration?.override_callback_uri ?? null,
      },
    });
  }

  // Webhook subscription, read back rather than assumed.
  const ourAppId = process.env.META_APP_ID || "";
  const subs = await client.listSubscribedApps(number.wabaId);
  if (subs.ok) {
    const subscribed = subs.value.some((s) => s.whatsapp_business_api_data?.id === ourAppId);
    await prisma.whatsAppNumber.update({
      where: { id: numberId },
      data: {
        webhookSubscribed: subscribed,
        webhookVerifiedAt: subscribed ? new Date() : null,
      },
    });
  }

  await checkNumberHealth(numberId, client);

  const refreshed = await prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: numberId } });
  const report = buildHealthReport(refreshed);

  // Re-derive state from current evidence. A number that recovered should say
  // so without needing a repair.
  const nextState: WhatsAppNumberState =
    refreshed.state === "DISCONNECTED" || refreshed.state === "ACTION_REQUIRED"
      ? refreshed.state
      : report.ready
        ? "CONNECTED"
        : "DEGRADED";

  if (nextState !== refreshed.state) {
    await prisma.whatsAppNumber.update({
      where: { id: numberId },
      data: {
        state: nextState,
        lastError: report.ready ? null : refreshed.lastError,
      },
    });
    await prisma.channelAccount.update({
      where: { id: refreshed.channelAccountId },
      data: { connectionStatus: nextState === "CONNECTED" ? "CONNECTED" : "PENDING" },
    });
    report.state = nextState;
    report.ready = nextState === "CONNECTED" && report.ready;
  }

  return report;
}

// ─── Repair ──────────────────────────────────────────────────

export interface RepairResult {
  action: RepairAction;
  succeeded: boolean;
  /** Plain sentence for the customer. */
  message: string;
  report?: NumberHealthReport;
}

/**
 * Attempt one repair on ONE number.
 *
 * Every action here is scoped to the number it is called for. Re-subscribing
 * webhooks is the only action that touches a WABA-level asset, and it is
 * additive: subscribing an already-subscribed app is a no-op at Meta, so it
 * cannot disturb a sibling number that is already working.
 */
export async function repairNumber(
  numberId: string,
  action: RepairAction,
): Promise<RepairResult> {
  const number = await prisma.whatsAppNumber.findUnique({ where: { id: numberId } });
  if (!number) {
    return { action, succeeded: false, message: "That number is no longer connected." };
  }

  const client = await clientForNumber(number);
  if (!client) {
    return {
      action,
      succeeded: false,
      message:
        "GOTCHA's access to this number has expired. Reconnect the number to restore it.",
    };
  }

  if (action === "RESUBSCRIBE_WEBHOOKS") {
    const sub = await client.subscribeApp(number.wabaId);
    if (!sub.ok) {
      await prisma.whatsAppNumberEvent.create({
        data: {
          numberId,
          step: "REPAIR_WEBHOOKS",
          outcome: "FAILED",
          message: sub.error.message,
          metaErrorCode: sub.error.code ?? null,
          detail: sub.error.redactedBody() as any,
        },
      });
      return {
        action,
        succeeded: false,
        message: sub.error.isPermissionError
          ? "GOTCHA no longer has permission to receive messages for this number. Reconnect it."
          : "WhatsApp would not restore message delivery for this number just now.",
      };
    }

    await prisma.whatsAppNumberEvent.create({
      data: { numberId, step: "REPAIR_WEBHOOKS", outcome: "SUCCESS" },
    });

    // Confirm by reading it back before claiming success.
    const report = await refreshNumberHealth(numberId);
    const fixed = report?.checks.find((c) => c.id === "WEBHOOKS")?.status === "PASS";
    await getRedis().del(`channel_account:WHATSAPP:${number.phoneNumberId}`);
    return {
      action,
      succeeded: Boolean(fixed),
      message: fixed
        ? "Message delivery is working again."
        : "WhatsApp accepted the request but is not delivering messages yet. Try again shortly.",
      report: report ?? undefined,
    };
  }

  const report = await refreshNumberHealth(numberId);
  return {
    action,
    succeeded: true,
    message: report?.ready
      ? "Everything is working."
      : "Status refreshed. See the details below for what still needs attention.",
    report: report ?? undefined,
  };
}

// ─── Disconnect ──────────────────────────────────────────────

export interface DisconnectResult {
  succeeded: boolean;
  message: string;
  /** True when webhooks were left alone because siblings still need them. */
  webhooksPreserved: boolean;
}

/**
 * Disconnect ONE number without touching any other.
 *
 * The subtlety that makes this correct: **Meta subscribes webhooks per WABA,
 * not per number.** So the obvious implementation - unsubscribe on disconnect -
 * would silence every OTHER number the tenant has on that same WABA. That is
 * precisely the cross-number damage Phase 8 forbids, and it is invisible in
 * testing unless a tenant happens to have two numbers on one WABA.
 *
 * So we unsubscribe only when this is the last connected number on the WABA.
 * Otherwise the subscription stays and the number is disconnected on our side
 * alone, which is correct: with no ChannelAccount row, its inbound messages are
 * discarded by the router.
 *
 * We deliberately do NOT call `deregister`. Deregistration frees the number for
 * the WhatsApp Business app but throws away its Cloud API registration, and
 * re-registering demands the two-step PIN again. That is a destructive,
 * hard-to-reverse act, and it is the customer's to choose, not a side effect of
 * clicking Remove.
 */
export async function disconnectNumber(
  numberId: string,
  tenantId: string,
): Promise<DisconnectResult> {
  const number = await prisma.whatsAppNumber.findFirst({
    where: { id: numberId, tenantId },
  });
  if (!number) {
    return { succeeded: false, message: "That number is not connected here.", webhooksPreserved: false };
  }

  // Any sibling still live on the same WABA?
  const siblings = await prisma.whatsAppNumber.count({
    where: {
      wabaId: number.wabaId,
      id: { not: numberId },
      state: { notIn: ["DISCONNECTED", "FAILED"] },
    },
  });

  let webhooksPreserved = true;
  if (siblings === 0) {
    const client = await clientForNumber(number);
    if (client) {
      const res = await client.unsubscribeApp(number.wabaId);
      webhooksPreserved = !res.ok;
      await prisma.whatsAppNumberEvent.create({
        data: {
          numberId,
          step: "UNSUBSCRIBE_WEBHOOKS",
          outcome: res.ok ? "SUCCESS" : "FAILED",
          message: res.ok ? "Last number on this account; unsubscribed." : res.error.message,
          metaErrorCode: res.ok ? null : (res.error.code ?? null),
        },
      });
    }
  } else {
    await prisma.whatsAppNumberEvent.create({
      data: {
        numberId,
        step: "UNSUBSCRIBE_WEBHOOKS",
        outcome: "SKIPPED",
        message: `${siblings} other connected number(s) share this WhatsApp account; subscription left in place.`,
      },
    });
  }

  await prisma.whatsAppNumber.update({
    where: { id: numberId },
    data: {
      state: "DISCONNECTED",
      disconnectedAt: new Date(),
      webhookSubscribed: false,
      pendingAction: null,
      lastError: null,
    },
  });

  await prisma.channelAccount.update({
    where: { id: number.channelAccountId },
    data: { connectionStatus: "DISCONNECTED", isActive: false },
  });

  await getRedis().del(`channel_account:WHATSAPP:${number.phoneNumberId}`);

  return {
    succeeded: true,
    message: siblings
      ? "Number disconnected. Your other WhatsApp numbers are unaffected."
      : "Number disconnected.",
    webhooksPreserved,
  };
}
