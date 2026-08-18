/**
 * Post-onboarding pipeline: everything Meta exposes an API for, done
 * automatically, for exactly ONE number.
 *
 * Phase 9 of the WhatsApp redesign. The unit of work is a single business
 * phone number, and that is the whole point:
 *
 *   * Adding a number must never interrupt an existing one (Phase 7).
 *   * Repairing one number must never affect the others (Phase 10).
 *   * Disconnecting one number must never affect any other (Phase 8).
 *
 * None of those are achievable while the unit of work is "the WABA", which is
 * what the previous implementation used - it looped over every phone number on
 * the customer's WABA and rewrote all of them on every connect.
 *
 * Every step is idempotent and every step is recorded. A step that already
 * succeeded is not re-run, which matters concretely: `POST /register` is
 * limited to 10 calls per number per 72-hour window, and that budget belongs to
 * the customer.
 *
 * Reference: docs/integrations/whatsapp/01-meta-api-inventory.md
 */

import { channelStatusForNumber } from "./health.service";
import {
  prisma,
  encryptCredentials,
  getRedis,
  MetaWhatsAppClient,
  META_ERROR,
  MetaApiError,
  inspectMetaAssets,
  selectFlow,
  type AutomatedStep,
  type FlowDecision,
  type InspectedNumber,
  type MetaInspection,
} from "@chatcenter/shared";
import type {
  WhatsAppNumberState,
  WhatsAppOnboardingFlow,
  WhatsAppPendingAction,
} from "@prisma/client";

// ─── Step recording ──────────────────────────────────────────

export type StepOutcome = "SUCCESS" | "FAILED" | "SKIPPED" | "ACTION_REQUIRED";

/**
 * Record what happened, with Meta's response kept whole.
 *
 * Phase 10 requires showing the customer the exact reason AND the API
 * response. That is only possible if the response was captured at the moment
 * it arrived; reconstructing it afterwards means guessing. `redactedBody()`
 * strips anything token-shaped first, so this is safe to persist and to render.
 */
async function recordStep(
  numberId: string,
  step: string,
  outcome: StepOutcome,
  opts: { message?: string; error?: MetaApiError; durationMs?: number; detail?: unknown } = {},
): Promise<void> {
  await prisma.whatsAppNumberEvent.create({
    data: {
      numberId,
      step,
      outcome,
      message: opts.message ?? opts.error?.message ?? null,
      metaErrorCode: opts.error?.code ?? null,
      detail: (opts.error ? opts.error.redactedBody() : opts.detail) as any,
      durationMs: opts.durationMs ?? null,
    },
  });
}

/** Has this step already succeeded for this number? Drives idempotency. */
async function hasSucceeded(numberId: string, step: string): Promise<boolean> {
  const hit = await prisma.whatsAppNumberEvent.findFirst({
    where: { numberId, step, outcome: "SUCCESS" },
    select: { id: true },
  });
  return hit != null;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const started = Date.now();
  const value = await fn();
  return { value, durationMs: Date.now() - started };
}

// ─── Inputs ──────────────────────────────────────────────────

export interface OnboardNumberInput {
  tenantId: string;
  userId?: string;
  /** Customer-scoped business token from the Embedded Signup code exchange. */
  accessToken: string;
  /** The ONE number being connected. Never a list. */
  phoneNumberId: string;
  wabaId: string;
  businessPortfolioId?: string;
  decision: FlowDecision;
  inspection: MetaInspection;
  /**
   * The customer's existing two-step verification PIN. Required only when the
   * flow says so. There is no Meta endpoint to read, reset or disable this, so
   * when a number has one, asking is the only option. The previous
   * implementation hardcoded "000000" and ignored the failure, then reported
   * the channel as connected.
   */
  twoStepPin?: string;
  /** ISO 3166 alpha-2, for Meta's local storage option. */
  dataLocalizationRegion?: string;
}

export interface OnboardResult {
  numberId: string;
  channelAccountId: string;
  state: WhatsAppNumberState;
  pendingAction: WhatsAppPendingAction | null;
  completedSteps: AutomatedStep[];
  failedStep?: AutomatedStep;
  /** Customer-facing explanation. Empty when everything worked. */
  message?: string;
}

const SCENARIO_TO_FLOW: Record<string, WhatsAppOnboardingFlow> = {
  NEW_NUMBER: "NEW_NUMBER",
  COEXISTENCE: "COEXISTENCE",
  EXISTING_CLOUD_API: "EXISTING_CLOUD_API",
  RECONNECT: "RECONNECT",
  MIGRATION: "MIGRATION",
};

// ─── The pipeline ────────────────────────────────────────────

/**
 * Run every automated step the decision calls for, against one number.
 *
 * Never throws for a Meta-side failure. A failure becomes a recorded step, an
 * honest state on the number, and a customer-facing message. Throwing would
 * lose the partial progress, and partial progress is exactly what makes the
 * next attempt cheap.
 */
export async function onboardNumber(input: OnboardNumberInput): Promise<OnboardResult> {
  const { tenantId, accessToken, phoneNumberId, wabaId, decision, inspection } = input;

  const client = new MetaWhatsAppClient({ accessToken });
  const inspected = inspection.numbers.find((n) => n.phoneNumberId === phoneNumberId);

  // ── Step: persist the number first ──
  // Deliberately before any Meta write. If the process dies mid-pipeline we
  // must still know the number exists and what state it reached; a number that
  // was subscribed at Meta but recorded nowhere is invisible and unrepairable.
  const { channelAccount, number } = await upsertNumberRecord({
    tenantId,
    userId: input.userId,
    accessToken,
    phoneNumberId,
    wabaId,
    businessPortfolioId: input.businessPortfolioId,
    flow: SCENARIO_TO_FLOW[decision.scenario] ?? "RECONNECT",
    inspected,
  });

  const completed: AutomatedStep[] = [];
  const steps = decision.automatedSteps.filter(
    (s) => s !== "EXCHANGE_TOKEN" && s !== "RESOLVE_ASSETS",
  );

  for (const step of steps) {
    const result = await runStep(step, {
      client,
      number,
      channelAccountId: channelAccount.id,
      wabaId,
      phoneNumberId,
      input,
      inspected,
    });

    if (result.outcome === "SUCCESS" || result.outcome === "SKIPPED") {
      completed.push(step);
      continue;
    }

    if (result.outcome === "ACTION_REQUIRED") {
      await prisma.whatsAppNumber.update({
        where: { id: number.id },
        data: {
          state: "ACTION_REQUIRED",
          pendingAction: result.pendingAction ?? null,
          lastError: result.message ?? null,
        },
      });
      return {
        numberId: number.id,
        channelAccountId: channelAccount.id,
        state: "ACTION_REQUIRED",
        pendingAction: result.pendingAction ?? null,
        completedSteps: completed,
        failedStep: step,
        message: result.message,
      };
    }

    // FAILED. Stop: later steps assume earlier ones worked, and running them
    // anyway produces a second, misleading error that buries the real one.
    await prisma.whatsAppNumber.update({
      where: { id: number.id },
      data: { state: "FAILED", lastError: result.message ?? "Setup failed." },
    });
    await syncChannelStatus(channelAccount.id, "ERROR", result.message);
    return {
      numberId: number.id,
      channelAccountId: channelAccount.id,
      state: "FAILED",
      pendingAction: null,
      completedSteps: completed,
      failedStep: step,
      message: result.message,
    };
  }

  // ── Settle final state from evidence, not from optimism ──
  const finalNumber = await prisma.whatsAppNumber.findUniqueOrThrow({
    where: { id: number.id },
  });

  // Webhook subscription is the load-bearing check. Without it the number can
  // send but never receive, which looks connected and is not. The previous
  // implementation wrote CONNECTED regardless on one of its two paths.
  const usable = finalNumber.webhookSubscribed && finalNumber.canSendMessage !== "BLOCKED";
  const state: WhatsAppNumberState = usable
    ? finalNumber.canSendMessage === "LIMITED"
      ? "DEGRADED"
      : "CONNECTED"
    : "DEGRADED";

  await prisma.whatsAppNumber.update({
    where: { id: number.id },
    data: {
      state,
      pendingAction: null,
      connectedAt: finalNumber.connectedAt ?? new Date(),
      lastError: usable ? null : "Incoming messages are not reaching GOTCHA yet.",
    },
  });

  // The CHANNEL is connected when it can carry traffic. Whether Meta currently
  // permits outbound is a warning on a connected channel, not a reason to tell
  // the whole product the channel does not exist. See channelStatusForNumber.
  //
  // `state` rather than `finalNumber.state`, and that is the whole fix.
  // `finalNumber` was read BEFORE the update above wrote the settled state, so
  // it still held ONBOARDING - which channelStatusForNumber maps to PENDING.
  // The channel row was therefore left PENDING on every successful onboarding,
  // and the Channels page showed a working, message-carrying number as
  // "Connecting..." indefinitely. Nothing ever corrected it, because this is
  // the only place the initial status is written.
  await syncChannelStatus(
    channelAccount.id,
    channelStatusForNumber({
      state,
      webhookSubscribed: finalNumber.webhookSubscribed,
      messagingStatus: finalNumber.messagingStatus,
    }),
    usable ? null : "Incoming messages are not reaching GOTCHA yet.",
  );

  // The inbound router caches channel lookups by phone number id.
  await getRedis().del(`channel_account:WHATSAPP:${phoneNumberId}`);

  return {
    numberId: number.id,
    channelAccountId: channelAccount.id,
    state,
    pendingAction: null,
    completedSteps: completed,
  };
}

// ─── Individual steps ────────────────────────────────────────

interface StepContext {
  client: MetaWhatsAppClient;
  number: { id: string };
  channelAccountId: string;
  wabaId: string;
  phoneNumberId: string;
  input: OnboardNumberInput;
  inspected?: InspectedNumber;
}

interface StepResult {
  outcome: StepOutcome;
  message?: string;
  pendingAction?: WhatsAppPendingAction;
}

async function runStep(step: AutomatedStep, ctx: StepContext): Promise<StepResult> {
  switch (step) {
    case "SUBSCRIBE_WEBHOOKS":
      return subscribeWebhooks(ctx);
    case "REGISTER_NUMBER":
      return registerNumber(ctx);
    case "SYNC_PROFILE":
      return syncProfile(ctx);
    case "HEALTH_CHECK":
      return healthCheckStep(ctx);
    case "REQUEST_HISTORY_SYNC":
      return requestHistorySync(ctx);
    default:
      // EXCHANGE_TOKEN and RESOLVE_ASSETS happen before the pipeline, in the
      // route. Reaching here means the step list gained a member nobody
      // implemented, which must be loud rather than silently skipped.
      await recordStep(ctx.number.id, step, "FAILED", {
        message: `No implementation for pipeline step "${step}".`,
      });
      return { outcome: "FAILED", message: "Setup hit an unexpected step." };
  }
}

/**
 * Subscribe our app to the WABA's webhooks, then READ IT BACK.
 *
 * The read-back is the point. `POST` returning 200 means Meta accepted the
 * request; only the number's presence in `GET /subscribed_apps` proves inbound
 * messages will actually arrive. Trusting the POST alone is how a channel ends
 * up marked connected while silently receiving nothing.
 */
async function subscribeWebhooks(ctx: StepContext): Promise<StepResult> {
  const ourAppId = process.env.META_APP_ID || "";

  const { value: sub, durationMs } = await timed(() => ctx.client.subscribeApp(ctx.wabaId));
  if (!sub.ok) {
    await recordStep(ctx.number.id, "SUBSCRIBE_WEBHOOKS", "FAILED", {
      error: sub.error,
      durationMs,
    });
    return {
      outcome: "FAILED",
      message: sub.error.isPermissionError
        ? "GOTCHA does not have permission to receive messages for this number. Reconnect and accept all permissions."
        : "WhatsApp would not let us start receiving messages for this number yet.",
    };
  }

  const listed = await ctx.client.listSubscribedApps(ctx.wabaId);
  const confirmed = listed.ok && listed.value.some((s) => s.whatsapp_business_api_data?.id === ourAppId);

  await prisma.whatsAppNumber.update({
    where: { id: ctx.number.id },
    data: {
      webhookSubscribed: confirmed,
      webhookVerifiedAt: confirmed ? new Date() : null,
      webhookOverrideUri:
        (listed.ok && listed.value.find((s) => s.override_callback_uri)?.override_callback_uri) ||
        null,
    },
  });

  if (!confirmed) {
    await recordStep(ctx.number.id, "SUBSCRIBE_WEBHOOKS", "FAILED", {
      message: "Subscription accepted but our app is not listed on the account.",
      detail: listed.ok ? listed.value : undefined,
      durationMs,
    });
    return {
      outcome: "FAILED",
      message: "WhatsApp accepted the connection but is not yet delivering messages to GOTCHA.",
    };
  }

  await recordStep(ctx.number.id, "SUBSCRIBE_WEBHOOKS", "SUCCESS", { durationMs });
  return { outcome: "SUCCESS" };
}

/**
 * Register the number for Cloud API use.
 *
 * Three ways this correctly does nothing:
 *
 *   * Coexistence numbers are ALREADY registered. Meta: "skip the phone number
 *     registration step". Calling register here would spend one of the ten
 *     allowed calls in the customer's 72-hour window for no reason.
 *   * A number already on Cloud API is registered by definition.
 *   * A previous successful registration is not repeated.
 *
 * And one way it correctly stops: no PIN. Meta requires the customer's
 * EXISTING two-step verification PIN, and publishes no endpoint to read, reset
 * or disable it. So we ask, rather than guessing "000000" and reporting
 * success we did not have.
 */
async function registerNumber(ctx: StepContext): Promise<StepResult> {
  if (ctx.inspected?.kind === "COEXISTENCE") {
    await recordStep(ctx.number.id, "REGISTER_NUMBER", "SKIPPED", {
      message: "Coexistence number is already registered by the WhatsApp Business app.",
    });
    return { outcome: "SKIPPED" };
  }

  if (ctx.inspected?.kind === "CLOUD_API") {
    await recordStep(ctx.number.id, "REGISTER_NUMBER", "SKIPPED", {
      message: "Number is already registered on Cloud API.",
    });
    return { outcome: "SKIPPED" };
  }

  if (await hasSucceeded(ctx.number.id, "REGISTER_NUMBER")) {
    await recordStep(ctx.number.id, "REGISTER_NUMBER", "SKIPPED", {
      message: "Already registered by an earlier run.",
    });
    return { outcome: "SKIPPED" };
  }

  const pin = ctx.input.twoStepPin;
  if (!pin) {
    await recordStep(ctx.number.id, "REGISTER_NUMBER", "ACTION_REQUIRED", {
      message: "Two-step verification PIN required and not supplied.",
    });
    return {
      outcome: "ACTION_REQUIRED",
      pendingAction: "TWO_STEP_PIN",
      message:
        "Enter the 6-digit PIN you use for two-step verification on this WhatsApp number. " +
        "If you have never set one, choose a new 6-digit PIN and keep it safe.",
    };
  }

  const { value: res, durationMs } = await timed(() =>
    ctx.client.register(ctx.phoneNumberId, pin, ctx.input.dataLocalizationRegion),
  );

  if (res.ok) {
    await recordStep(ctx.number.id, "REGISTER_NUMBER", "SUCCESS", { durationMs });
    return { outcome: "SUCCESS" };
  }

  const code = res.error.code;

  if (code === META_ERROR.INCORRECT_PIN) {
    await recordStep(ctx.number.id, "REGISTER_NUMBER", "ACTION_REQUIRED", {
      error: res.error,
      durationMs,
    });
    return {
      outcome: "ACTION_REQUIRED",
      pendingAction: "TWO_STEP_PIN",
      message:
        "That PIN did not match the one on this WhatsApp number. Try again. WhatsApp does not " +
        "let us reset it for you, so if you cannot recall it you will need to change it in " +
        "WhatsApp first.",
    };
  }

  if (code === META_ERROR.NOT_VERIFIED) {
    await recordStep(ctx.number.id, "REGISTER_NUMBER", "ACTION_REQUIRED", {
      error: res.error,
      durationMs,
    });
    return {
      outcome: "ACTION_REQUIRED",
      pendingAction: "VERIFICATION_CODE",
      message: "This number still needs to be verified with WhatsApp before it can be used.",
    };
  }

  if (code === META_ERROR.REGISTER_RATE_LIMIT) {
    // Ten calls per number per 72 hours. Retrying strictly worsens it, so this
    // stops and says so honestly rather than looping.
    await recordStep(ctx.number.id, "REGISTER_NUMBER", "FAILED", {
      error: res.error,
      durationMs,
    });
    return {
      outcome: "FAILED",
      message:
        "WhatsApp has temporarily paused setup attempts for this number. Try again in a few " +
        "hours; nothing is lost in the meantime.",
    };
  }

  await recordStep(ctx.number.id, "REGISTER_NUMBER", "FAILED", { error: res.error, durationMs });
  return { outcome: "FAILED", message: "WhatsApp could not finish setting up this number." };
}

/** Re-read the number's own fields and mirror them onto the lifecycle row. */
async function syncProfile(ctx: StepContext): Promise<StepResult> {
  const { value: res, durationMs } = await timed(() =>
    ctx.client.getPhoneNumber(ctx.phoneNumberId),
  );
  if (!res.ok) {
    await recordStep(ctx.number.id, "SYNC_PROFILE", "FAILED", { error: res.error, durationMs });
    // Non-fatal: cosmetic fields. Failing the whole connection over a display
    // name would be a worse outcome than a slightly stale card.
    return { outcome: "SKIPPED", message: "Could not refresh the number's details." };
  }

  const p = res.value;
  await prisma.whatsAppNumber.update({
    where: { id: ctx.number.id },
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

  if (p.verified_name || p.display_phone_number) {
    await prisma.channelAccount.update({
      where: { id: ctx.channelAccountId },
      data: { displayName: p.verified_name || p.display_phone_number! },
    });
  }

  await recordStep(ctx.number.id, "SYNC_PROFILE", "SUCCESS", { durationMs });
  return { outcome: "SUCCESS" };
}

async function healthCheckStep(ctx: StepContext): Promise<StepResult> {
  const result = await checkNumberHealth(ctx.number.id, ctx.client);
  return result.checked
    ? { outcome: "SUCCESS" }
    : { outcome: "SKIPPED", message: "Could not read the health of this number." };
}

// ─── Persistence helpers ─────────────────────────────────────

/**
 * Create or update the ChannelAccount + WhatsAppNumber pair for ONE number.
 *
 * The token is written to `ChannelAccount.credentials` per number, even though
 * several numbers on the same WABA share a business token. That duplication is
 * deliberate: revoking one number must never reach another number's ability to
 * send. Sharing a row would make isolation impossible.
 */
async function upsertNumberRecord(args: {
  tenantId: string;
  userId?: string;
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
  businessPortfolioId?: string;
  flow: WhatsAppOnboardingFlow;
  inspected?: InspectedNumber;
}) {
  const { tenantId, phoneNumberId, wabaId, inspected } = args;

  const displayName =
    inspected?.verifiedName || inspected?.displayPhoneNumber || phoneNumberId;

  const credentials = encryptCredentials({
    accessToken: args.accessToken,
    wabaId,
    phoneNumber: inspected?.displayPhoneNumber,
  });

  // Unique-key lookup on (channel, externalId). A row belonging to another
  // tenant must never be adopted; the caller has already blocked that case
  // through the inspector, and this is the second line of defence.
  const existing = await prisma.channelAccount.findUnique({
    where: { channel_externalId: { channel: "WHATSAPP", externalId: phoneNumberId } },
  });

  if (existing && existing.tenantId !== tenantId) {
    throw new Error("This WhatsApp number is connected to a different workspace.");
  }

  const channelAccount = existing
    ? await prisma.channelAccount.update({
        where: { id: existing.id },
        data: {
          credentials,
          isActive: true,
          connectedAt: existing.connectedAt ?? new Date(),
          connectedBy: args.userId,
          // Honest until the pipeline proves otherwise. Writing CONNECTED here
          // and correcting later is what produced channels that claimed to
          // work and did not.
          connectionStatus: "PENDING",
          platformMeta: { wabaId, businessPortfolioId: args.businessPortfolioId },
        },
      })
    : await prisma.channelAccount.create({
        data: {
          tenantId,
          channel: "WHATSAPP",
          externalId: phoneNumberId,
          displayName,
          credentials,
          connectionStatus: "PENDING",
          connectedAt: new Date(),
          connectedBy: args.userId,
          isActive: true,
          platformMeta: { wabaId, businessPortfolioId: args.businessPortfolioId },
        },
      });

  const number = await prisma.whatsAppNumber.upsert({
    where: { phoneNumberId },
    create: {
      tenantId,
      channelAccountId: channelAccount.id,
      phoneNumberId,
      wabaId,
      businessPortfolioId: args.businessPortfolioId,
      displayPhoneNumber: inspected?.displayPhoneNumber,
      verifiedName: inspected?.verifiedName,
      platformType: inspected?.platformType,
      isOnBizApp: inspected?.isOnBizApp ?? false,
      onboardingFlow: args.flow,
      state: "ONBOARDING",
      messagingStatus: inspected?.status,
      codeVerificationStatus: inspected?.codeVerificationStatus,
      nameStatus: inspected?.nameStatus,
      qualityRating: inspected?.qualityRating,
      throughputLevel: inspected?.throughputLevel,
      messagingLimitTier: inspected?.messagingLimitTier,
      connectedBy: args.userId,
    },
    update: {
      channelAccountId: channelAccount.id,
      wabaId,
      businessPortfolioId: args.businessPortfolioId,
      onboardingFlow: args.flow,
      state: "ONBOARDING",
      lastError: null,
      pendingAction: null,
      disconnectedAt: null,
    },
  });

  return { channelAccount, number };
}

/**
 * Ask Meta to send the business's past conversations and contacts.
 *
 * ── Why this exists ──
 *
 * Subscribing to the `history` webhook field says WHERE to deliver. It does not
 * ask for anything. Meta requires an explicit
 * `POST /<PHONE_NUMBER_ID>/smb_app_data` to start the transfer, and without it
 * nothing is ever sent.
 *
 * That was the defect, and it was invisible: the field was subscribed, the
 * number connected cleanly, every step in this pipeline reported SUCCESS, and
 * the customer's history simply never arrived. Nothing anywhere recorded that
 * the one call that matters had never been made, because we only logged the
 * steps we did run.
 *
 * ── Once only, and a 24-hour deadline ──
 *
 * Meta grants one synchronization per onboarding. Repeating it requires the
 * customer to offboard in the WhatsApp Business app and complete Embedded
 * Signup again, so this must never retry blindly. The step log is the guard:
 * a run that already recorded SUCCESS here skips, which also makes the whole
 * pipeline safe to re-run for any other reason.
 *
 * ── Why a failure here is not a failure of onboarding ──
 *
 * The number works. Messages flow. What the customer loses is the history
 * import, which is an onboarding bonus rather than the channel itself, so this
 * returns SKIPPED rather than FAILED and the connection stands.
 */
async function requestHistorySync(ctx: StepContext): Promise<StepResult> {
  const { number, client, phoneNumberId } = ctx;

  // Coexistence only. Meta rejects it for any other number, and a number that
  // was never on the WhatsApp Business app has no history to send. Read from
  // the row rather than the inspection, so a re-run after a restart still knows.
  const row = await prisma.whatsAppNumber.findUnique({
    where: { id: number.id },
    select: { isOnBizApp: true },
  });
  if (!row?.isOnBizApp) {
    return { outcome: "SKIPPED", message: "Not a WhatsApp Business app number." };
  }

  // Once only. A second request cannot succeed and Meta counts the attempt.
  const already = await prisma.whatsAppNumberEvent.findFirst({
    where: { numberId: number.id, step: "REQUEST_HISTORY_SYNC", outcome: "SUCCESS" },
    select: { id: true },
  });
  if (already) {
    return { outcome: "SKIPPED", message: "History was already requested for this onboarding." };
  }

  // Contacts first, then messages, in the order Meta documents them. The
  // contact sync is best-effort: it is genuinely optional, and letting it stop
  // the message history would trade the valuable half for the cheap half.
  const contacts = await client.requestSmbSync(phoneNumberId, "smb_app_state_sync");
  await recordStep(number.id, "REQUEST_CONTACT_SYNC", contacts.ok ? "SUCCESS" : "FAILED", {
    ...(contacts.ok ? { detail: contacts.value } : { error: contacts.error }),
  });

  const history = await client.requestSmbSync(phoneNumberId, "history");
  if (!history.ok) {
    return {
      outcome: "SKIPPED",
      message:
        "WhatsApp would not start the history transfer. The number is connected and working; " +
        "importing past conversations would need disconnecting in the WhatsApp Business app and connecting again.",
    };
  }

  console.log(
    `[whatsapp-history] requested sync number=${number.id} phoneNumberId=${phoneNumberId} ` +
      `contacts=${contacts.ok ? "ok" : "failed"} history=ok`,
  );
  return { outcome: "SUCCESS" };
}

/** Keep the channel row's status honest and in step with the number's. */
async function syncChannelStatus(
  channelAccountId: string,
  status: "CONNECTED" | "PENDING" | "ERROR" | "DISCONNECTED",
  lastError?: string | null,
): Promise<void> {
  await prisma.channelAccount.update({
    where: { id: channelAccountId },
    data: { connectionStatus: status, lastError: lastError ?? null },
  });
}

// ─── Health, shared with the repair engine ───────────────────

export interface HealthResult {
  checked: boolean;
  canSendMessage?: string;
  state?: WhatsAppNumberState;
}

/**
 * Read Meta's health for one number and store it whole.
 *
 * `possible_solution` in the stored snapshot is Meta's own remediation text
 * and is rendered verbatim. Paraphrasing "your business needs to complete
 * verification" into "something went wrong" leaves the customer unable to act
 * on the one problem only they can fix.
 */
export async function checkNumberHealth(
  numberId: string,
  client: MetaWhatsAppClient,
): Promise<HealthResult> {
  const number = await prisma.whatsAppNumber.findUnique({ where: { id: numberId } });
  if (!number) return { checked: false };

  const { value: res, durationMs } = await timed(() =>
    client.getHealthStatus(number.phoneNumberId),
  );

  if (!res.ok) {
    await recordStep(numberId, "HEALTH_CHECK", "FAILED", { error: res.error, durationMs });
    await prisma.whatsAppNumber.update({
      where: { id: numberId },
      data: { lastHealthCheck: new Date() },
    });
    return { checked: false };
  }

  const health = res.value;
  const canSend = health.can_send_message;

  await prisma.whatsAppNumber.update({
    where: { id: numberId },
    data: {
      healthSnapshot: health as any,
      canSendMessage: canSend ?? null,
      lastHealthCheck: new Date(),
    },
  });

  await recordStep(numberId, "HEALTH_CHECK", "SUCCESS", {
    durationMs,
    detail: { can_send_message: canSend },
  });

  return { checked: true, canSendMessage: canSend };
}

// ─── Entry point used by the connect route ───────────────────

export interface ConnectNumberInput {
  tenantId: string;
  userId?: string;
  accessToken: string;
  phoneNumberId: string;
  businessPortfolioId?: string;
  wabaIds?: string[];
  twoStepPin?: string;
  dataLocalizationRegion?: string;
}

/**
 * Inspect, decide, then onboard - the whole Phase 3-4-9 sequence for one
 * number.
 *
 * Kept as one function because the three stages must see the SAME inspection.
 * Re-inspecting between deciding and acting would let the customer's Meta state
 * change underneath the decision, and a flow chosen for one state applied to
 * another is precisely the class of bug this project exists to remove.
 */
export async function inspectDecideOnboard(input: ConnectNumberInput): Promise<{
  decision: FlowDecision;
  inspection: MetaInspection;
  result?: OnboardResult;
}> {
  const appId = process.env.META_APP_ID || "";
  const appSecret = process.env.META_APP_SECRET || "";
  const client = new MetaWhatsAppClient({ accessToken: input.accessToken });

  // Which numbers does GOTCHA already know about, and whose are they? Passed
  // into the inspector so it stays database-free and testable.
  const known = await prisma.whatsAppNumber.findMany({
    select: { phoneNumberId: true, tenantId: true },
  });
  const knownNumbers = new Map(known.map((n) => [n.phoneNumberId, n.tenantId]));

  const inspection = await inspectMetaAssets({
    client,
    appId,
    appSecret,
    ourAppId: appId,
    knownNumbers,
    tenantId: input.tenantId,
    hints: { businessPortfolioId: input.businessPortfolioId, wabaIds: input.wabaIds },
    includeHealth: true,
  });

  const decision = selectFlow({
    inspection,
    targetPhoneNumberId: input.phoneNumberId,
  });

  if (decision.scenario === "BLOCKED") {
    return { decision, inspection };
  }

  const result = await onboardNumber({
    tenantId: input.tenantId,
    userId: input.userId,
    accessToken: input.accessToken,
    phoneNumberId: decision.phoneNumberId || input.phoneNumberId,
    wabaId: decision.wabaId || "",
    businessPortfolioId: input.businessPortfolioId,
    decision,
    inspection,
    twoStepPin: input.twoStepPin,
    dataLocalizationRegion: input.dataLocalizationRegion,
  });

  return { decision, inspection, result };
}
