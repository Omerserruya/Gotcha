/**
 * WhatsApp numbers management API.
 *
 * Phase 8. Every route here is scoped to ONE number and enforces that scope in
 * the query itself (`where: { id, tenantId }`), rather than fetching by id and
 * checking ownership afterwards. That is what makes "removing one number never
 * affects another" a property of the code rather than a promise in a comment.
 *
 * Mounted at /api/channels/whatsapp.
 *
 *   GET    /numbers                   list, with per-number health
 *   POST   /inspect                   Phase 3 pre-flight: what does this
 *                                     customer actually have, and which flow
 *                                     would run
 *   POST   /connect                   inspect -> decide -> onboard, ONE number
 *   POST   /numbers/:id/resume        supply what the customer was asked for
 *   POST   /numbers/:id/refresh       re-read health from Meta
 *   POST   /numbers/:id/repair        run one repair action
 *   DELETE /numbers/:id               disconnect ONE number
 *   GET    /numbers/:id/events        the audit trail for one number
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  prisma,
  normalizeExclusionValue,
  exclusionDisplayValue,
  authenticate,
  resolveTenant,
  requirePermission,
  requireCapacity,
  validate,
  decryptCredentials,
  MetaWhatsAppClient,
  inspectMetaAssets,
  selectFlow,
  businessAppOptions,
  evaluatePathOutcome,
} from "@chatcenter/shared";
import { inspectDecideOnboard } from "../services/whatsapp/onboarding.service";
import {
  startSignupSession,
  readSignupSession,
} from "../services/whatsapp/signup-session";
import {
  buildHealthReport,
  disconnectNumber,
  refreshNumberHealth,
  repairNumber,
  type RepairAction,
} from "../services/whatsapp/health.service";

const router = Router();

const META_APP_ID = process.env.META_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";

/**
 * Express types `req.params.id` as `string | string[]` in this codebase.
 * Narrowed in one place so every route below reads a plain id, and a caller
 * who sends `?id=a&id=b` gets the first value rather than a type crash.
 */
function paramId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
}

/**
 * Plan channel limit, counted the same way the rest of /api/channels counts it
 * so a tenant cannot add numbers here to sidestep the cap enforced there.
 */
const requireChannelCapacity = requireCapacity("limit:channels", (tenantId) =>
  prisma.channelAccount.count({
    where: { tenantId, connectionStatus: { not: "DISCONNECTED" } },
  }),
);

// ─── List ────────────────────────────────────────────────────

/**
 * Every WhatsApp number on this workspace, each with its own health.
 *
 * Health is built from stored state rather than by calling Meta per number:
 * a tenant with a dozen numbers would otherwise fan out a dozen Graph requests
 * on every page render, which is slow and spends the customer's rate budget to
 * learn nothing new. `POST /numbers/:id/refresh` is the deliberate re-read.
 */
router.get(
  "/numbers",
  authenticate,
  resolveTenant,
  requirePermission("channels:manage:read"),
  async (req: Request, res: Response) => {
    const numbers = await prisma.whatsAppNumber.findMany({
      where: { tenantId: req.tenantId! },
      orderBy: [{ state: "asc" }, { createdAt: "asc" }],
    });

    const data = numbers.map((n) => ({
      id: n.id,
      phoneNumber: n.displayPhoneNumber,
      name: n.verifiedName,
      state: n.state,
      pendingAction: n.pendingAction,
      onboardingFlow: n.onboardingFlow,
      /**
       * The messaging identity behind this number. Exposed so the card can pair
       * a number with its history import, which is keyed by channel account
       * rather than by number - a tenant with two Coexistence numbers has two
       * separate imports, and the wrong pairing would show one number the
       * other's progress.
       */
      channelAccountId: n.channelAccountId,
      /** Coexistence numbers behave differently, so the UI must know. */
      usesBusinessApp: n.isOnBizApp,
      qualityRating: n.qualityRating,
      throughputLevel: n.throughputLevel,
      connectedAt: n.connectedAt,
      health: buildHealthReport(n),
    }));

    // Legacy WhatsApp channels connected before this feature existed have no
    // lifecycle row. They are surfaced rather than hidden, because a number the
    // customer can see in their inbox but not on this page reads as a bug.
    const profiledIds = new Set(numbers.map((n) => n.phoneNumberId));
    const legacy = await prisma.channelAccount.findMany({
      where: { tenantId: req.tenantId!, channel: "WHATSAPP" },
      select: { id: true, externalId: true, displayName: true, connectionStatus: true },
    });

    return res.json({
      data,
      unprofiled: legacy
        .filter((c) => !profiledIds.has(c.externalId))
        .map((c) => ({
          channelAccountId: c.id,
          phoneNumberId: c.externalId,
          name: c.displayName,
          connectionStatus: c.connectionStatus,
          note: "Connected before per-number health was available. Reconnect it to enable health checks and repair.",
        })),
    });
  },
);

// ─── Inspect (Phase 3 pre-flight) ────────────────────────────

const inspectSchema = z.object({
  /** Authorization code from Embedded Signup. Exchanged here, server-side. */
  code: z.string().min(1),
  /**
   * Which Embedded Signup flow produced this code.
   *
   * Optional and defaulted since the move to Embedded Signup v4: v4 is a
   * single unified flow that presents the supported onboarding choices inside
   * Meta's own UI, so GOTCHA no longer picks a door up front. Retained for the
   * Coexistence-specific flow, which is still selected by `featureType` when a
   * configuration enables it.
   */
  path: z.enum(["new", "business-app"]).optional().default("new"),
  businessPortfolioId: z.string().optional(),
  wabaIds: z.array(z.string()).optional(),
});

/**
 * Look at what the customer has, and say which flow each number would take.
 *
 * Read-only against Meta: no subscription, no registration, no database write.
 * Safe to call repeatedly, including on a fully healthy workspace.
 */
router.post(
  "/inspect",
  authenticate,
  resolveTenant,
  requirePermission("channels:manage:update"),
  validate(inspectSchema),
  async (req: Request, res: Response) => {
    const { code, path, businessPortfolioId, wabaIds } = req.body;

    let accessToken: string;
    try {
      accessToken = await MetaWhatsAppClient.exchangeCode({
        appId: META_APP_ID,
        appSecret: META_APP_SECRET,
        code,
      });
    } catch (err: any) {
      console.error("[wa-numbers] code exchange failed:", err?.message);
      return res
        .status(400)
        .json({ error: "Meta did not accept the authorization. Try connecting again." });
    }

    // Held server-side, keyed by tenant so one workspace's session can never
    // be replayed by another. Replacing the tenant's previous session is part
    // of this call: a relaunch is a new authorization, and the old token is
    // from a grant the customer walked away from.
    const sessionId = await startSignupSession(req.tenantId!, {
      accessToken,
      path,
      businessPortfolioId,
      wabaIds,
    });

    const known = await prisma.whatsAppNumber.findMany({
      select: { phoneNumberId: true, tenantId: true },
    });

    try {
      const inspection = await inspectMetaAssets({
        client: new MetaWhatsAppClient({ accessToken }),
        appId: META_APP_ID,
        appSecret: META_APP_SECRET,
        ourAppId: META_APP_ID,
        knownNumbers: new Map(known.map((n) => [n.phoneNumberId, n.tenantId])),
        tenantId: req.tenantId!,
        hints: { businessPortfolioId, wabaIds },
        includeHealth: true,
      });

      // One decision per number, so the UI can label each candidate with what
      // would actually happen to it before the customer commits.
      const candidates = inspection.numbers.map((n) => {
        const decision = selectFlow({ inspection, targetPhoneNumberId: n.phoneNumberId });
        return {
          phoneNumberId: n.phoneNumberId,
          phoneNumber: n.displayPhoneNumber,
          name: n.verifiedName,
          usesBusinessApp: n.isOnBizApp,
          alreadyConnectedHere: n.connectedToThisTenant,
          scenario: decision.scenario,
          message: decision.customerMessage,
          customerAction: decision.customerAction,
          blockers: decision.blockers,
          ...(decision.migrationOffer ? { migrationOffer: decision.migrationOffer } : {}),
          ...(n.isOnBizApp ? { businessAppOptions: businessAppOptions() } : {}),
        };
      });

      // Verification trail for dev runs. Logs only IDs and counts, never the
      // token and never customer message content, so it is safe to leave on.
      // `[wa-verify]` is greppable in `docker compose logs auth`.
      console.log(
        `[wa-verify] inspect tenant=${req.tenantId} path=${path} ` +
          `business_id=${businessPortfolioId || "-"} waba_ids=${(wabaIds || []).join(",") || "-"} ` +
          `candidates=${candidates.length} ` +
          `granted=${inspection.grantedScopes.join("|") || "-"} ` +
          `missing=${inspection.missingPermissions.join("|") || "-"} ` +
          `degraded=${inspection.degraded}`,
      );

      // What to tell the customer when this flow yielded nothing usable.
      // Computed server-side so the UI cannot drift from the rule, and so the
      // logic stays unit-tested rather than living in a component.
      const outcome = evaluatePathOutcome(path, candidates);

      return res.json({
        data: {
          /** Opaque handle to the server-held token. Not a credential. */
          sessionId,
          path,
          outcome,
          candidates,
          // Surfaced so the UI can say what it could NOT check, rather than
          // silently reporting a narrower view as complete.
          degraded: inspection.degraded,
          degradedReasons: inspection.degradedReasons,
          missingPermissions: inspection.missingPermissions,
          portfolios: inspection.portfolios,
          inspectedAt: inspection.inspectedAt,
        },
      });
    } catch (err: any) {
      // debug_token failing is the one unrecoverable case: we do not know what
      // the token can do, so every later call would be a guess.
      console.error("[wa-numbers] inspect failed:", err?.message);
      return res.status(502).json({
        error: "We could not read your WhatsApp setup from Meta. Try connecting again.",
      });
    }
  },
);

// ─── Connect ONE number ──────────────────────────────────────

const connectSchema = z.object({
  /**
   * Handle returned by /inspect, which holds the exchanged business token
   * server-side. The browser never sees the token, and the single-use
   * authorization code is never exchanged twice.
   */
  sessionId: z.string().min(1),
  /** The ONE number to connect. Always required, even when only one exists. */
  phoneNumberId: z.string().min(1),
  /** Customer's existing two-step verification PIN, when Meta needs it. */
  twoStepPin: z.string().regex(/^\d{6}$/).optional(),
  dataLocalizationRegion: z.string().length(2).optional(),
});

/**
 * Connect exactly one number.
 *
 * `phoneNumberId` is required, and that is the single most important
 * difference from what this replaces: the previous route looped over every
 * number on the customer's WABA and rebound all of them, so a customer adding
 * their support line silently had their sales line rewritten too.
 *
 * The signup session is deliberately NOT consumed here. A customer who
 * authorised once and has three numbers should be able to add all three
 * without re-authorising for each, which is what makes multi-number setup
 * feel like one task rather than three. The session expires on its own.
 */
router.post(
  "/connect",
  authenticate,
  resolveTenant,
  requirePermission("channels:manage:update"),
  requireChannelCapacity,
  validate(connectSchema),
  async (req: Request, res: Response) => {
    const { sessionId, phoneNumberId, twoStepPin, dataLocalizationRegion } = req.body;

    // Tenant-keyed, so a session id leaked from one workspace cannot be used
    // to act on another. Null covers expired, replaced and foreign alike:
    // from the customer's side they are the same, start again.
    const session = await readSignupSession(req.tenantId!, sessionId);
    if (!session) {
      return res.status(410).json({
        error: "That WhatsApp connection has expired. Start connecting again.",
      });
    }

    try {
      const { decision, result } = await inspectDecideOnboard({
        tenantId: req.tenantId!,
        userId: req.user?.userId,
        accessToken: session.accessToken,
        phoneNumberId,
        businessPortfolioId: session.businessPortfolioId,
        wabaIds: session.wabaIds,
        twoStepPin,
        dataLocalizationRegion,
      });

      if (decision.scenario === "BLOCKED") {
        return res.status(409).json({
          error: decision.customerMessage,
          blockers: decision.blockers,
        });
      }

      const number = result
        ? await prisma.whatsAppNumber.findUnique({ where: { id: result.numberId } })
        : null;

      console.log(
        `[wa-verify] connect tenant=${req.tenantId} phone_number_id=${phoneNumberId} ` +
          `scenario=${decision.scenario} waba_id=${decision.wabaId || "-"} ` +
          `state=${result?.state || "-"} pending=${result?.pendingAction || "-"} ` +
          `steps=${(result?.completedSteps || []).join(",") || "-"} ` +
          `webhook_subscribed=${number?.webhookSubscribed ?? "-"} ` +
          `platform_type=${number?.platformType || "-"} is_on_biz_app=${number?.isOnBizApp ?? "-"}`,
      );

      return res.status(201).json({
        data: {
          scenario: decision.scenario,
          message: result?.message || decision.customerMessage,
          state: result?.state,
          pendingAction: result?.pendingAction,
          completedSteps: result?.completedSteps,
          health: number ? buildHealthReport(number) : undefined,
          ...(decision.migrationOffer ? { migrationOffer: decision.migrationOffer } : {}),
        },
      });
    } catch (err: any) {
      console.error("[wa-numbers] connect failed:", err?.message);
      return res.status(500).json({ error: "We could not finish connecting this number." });
    }
  },
);

// ─── Resume a number that was waiting on the customer ────────

const resumeSchema = z.object({
  twoStepPin: z.string().regex(/^\d{6}$/).optional(),
  verificationCode: z.string().min(4).max(8).optional(),
});

/**
 * Supply what the customer was asked for and continue that number's pipeline.
 *
 * Scoped to one number; the other numbers on the workspace are not read, not
 * written and not affected.
 */
router.post(
  "/numbers/:id/resume",
  authenticate,
  resolveTenant,
  requirePermission("channels:manage:update"),
  validate(resumeSchema),
  async (req: Request, res: Response) => {
    const number = await prisma.whatsAppNumber.findFirst({
      where: { id: paramId(req), tenantId: req.tenantId! },
    });
    if (!number) return res.status(404).json({ error: "Number not found." });

    const channel = await prisma.channelAccount.findUnique({
      where: { id: number.channelAccountId },
      select: { credentials: true },
    });
    if (!channel) return res.status(409).json({ error: "This number needs reconnecting." });

    let accessToken: string;
    try {
      accessToken = decryptCredentials(channel.credentials as any)?.accessToken;
      if (!accessToken) throw new Error("no token");
    } catch {
      return res.status(409).json({
        error: "GOTCHA's access to this number has expired. Reconnect it.",
      });
    }

    try {
      const { decision, result } = await inspectDecideOnboard({
        tenantId: req.tenantId!,
        userId: req.user?.userId,
        accessToken,
        phoneNumberId: number.phoneNumberId,
        businessPortfolioId: number.businessPortfolioId || undefined,
        wabaIds: [number.wabaId],
        twoStepPin: req.body.twoStepPin,
      });

      const refreshed = result
        ? await prisma.whatsAppNumber.findUnique({ where: { id: result.numberId } })
        : null;

      return res.json({
        data: {
          scenario: decision.scenario,
          state: result?.state,
          pendingAction: result?.pendingAction,
          message: result?.message,
          health: refreshed ? buildHealthReport(refreshed) : undefined,
        },
      });
    } catch (err: any) {
      console.error("[wa-numbers] resume failed:", err?.message);
      return res.status(500).json({ error: "We could not finish setting up this number." });
    }
  },
);

// ─── Health ──────────────────────────────────────────────────

router.post(
  "/numbers/:id/refresh",
  authenticate,
  resolveTenant,
  requirePermission("channels:manage:read"),
  async (req: Request, res: Response) => {
    const owned = await prisma.whatsAppNumber.findFirst({
      where: { id: paramId(req), tenantId: req.tenantId! },
      select: { id: true },
    });
    if (!owned) return res.status(404).json({ error: "Number not found." });

    const report = await refreshNumberHealth(owned.id);
    return res.json({ data: report });
  },
);

const repairSchema = z.object({
  action: z.enum(["RESUBSCRIBE_WEBHOOKS", "REFRESH_STATUS", "REQUEST_HISTORY_SYNC"]),
});

router.post(
  "/numbers/:id/repair",
  authenticate,
  resolveTenant,
  requirePermission("channels:manage:update"),
  validate(repairSchema),
  async (req: Request, res: Response) => {
    const owned = await prisma.whatsAppNumber.findFirst({
      where: { id: paramId(req), tenantId: req.tenantId! },
      select: { id: true },
    });
    if (!owned) return res.status(404).json({ error: "Number not found." });

    const result = await repairNumber(owned.id, req.body.action as RepairAction);
    return res.status(result.succeeded ? 200 : 502).json({ data: result });
  },
);

// ─── Disconnect ──────────────────────────────────────────────

/**
 * Remove ONE number.
 *
 * The cross-number safety is in `disconnectNumber`: Meta subscribes webhooks
 * per WABA, so unsubscribing here would silence sibling numbers sharing that
 * account. The service checks for siblings first and leaves the subscription
 * alone when any remain.
 */
router.delete(
  "/numbers/:id",
  authenticate,
  resolveTenant,
  requirePermission("channels:manage:update"),
  async (req: Request, res: Response) => {
    const result = await disconnectNumber(paramId(req), req.tenantId!);
    if (!result.succeeded) return res.status(404).json({ error: result.message });
    return res.json({ data: result });
  },
);

// ─── Exclusions - numbers the owner keeps on their own phone ─

/**
 * Coexistence delivers EVERY conversation on the number to us, including the
 * ones that were never meant for a shared inbox. These rules are the only way
 * to say "that one is mine" short of not connecting Coexistence at all.
 *
 * Scoped to a `channelAccountId` when the caller names a number, so a tenant
 * running two WhatsApp numbers can exclude a contact on the one that lives in
 * the app without silently dropping the same person on the other.
 */
router.get(
  "/exclusions",
  authenticate,
  resolveTenant,
  requirePermission("channels:manage:read"),
  async (req: Request, res: Response) => {
    const rules = await prisma.inboundExclusion.findMany({
      where: { tenantId: req.tenantId!, channel: "WHATSAPP" },
      orderBy: { createdAt: "desc" },
    });
    return res.json({
      data: rules.map((r) => ({
        id: r.id,
        value: r.displayValue || r.customerExternalId,
        normalized: r.customerExternalId,
        channelAccountId: r.channelAccountId,
        note: r.note,
        createdAt: r.createdAt,
      })),
    });
  },
);

router.post(
  "/exclusions",
  authenticate,
  resolveTenant,
  requirePermission("channels:manage:update"),
  async (req: Request, res: Response) => {
    const raw = String(req.body?.value ?? "");
    const normalized = normalizeExclusionValue(raw);
    // A rule that matches nothing is worse than no rule: it sits in the list
    // looking like protection the owner does not actually have.
    if (normalized.length < 6) {
      return res.status(400).json({ error: "invalid_number", message: "Enter a phone number with at least 6 digits." });
    }

    // An account id from another tenant must not scope our rule.
    const channelAccountId = req.body?.channelAccountId ? String(req.body.channelAccountId) : null;
    if (channelAccountId) {
      const owned = await prisma.channelAccount.findFirst({
        where: { id: channelAccountId, tenantId: req.tenantId!, channel: "WHATSAPP" },
        select: { id: true },
      });
      if (!owned) return res.status(404).json({ error: "channel_account_not_found" });
    }

    const note = req.body?.note ? String(req.body.note).slice(0, 280) : null;

    // Upsert, matching the unique key: re-adding a number the owner already
    // excluded should update the note, not fail with a duplicate they cannot
    // see or fix from the UI.
    const rule = await prisma.inboundExclusion.upsert({
      where: {
        tenantId_channel_customerExternalId: {
          tenantId: req.tenantId!,
          channel: "WHATSAPP",
          customerExternalId: normalized,
        },
      },
      create: {
        tenantId: req.tenantId!,
        channel: "WHATSAPP",
        channelAccountId,
        customerExternalId: normalized,
        displayValue: exclusionDisplayValue(raw),
        note,
        createdBy: req.user?.userId ?? null,
      },
      update: { channelAccountId, displayValue: exclusionDisplayValue(raw), note },
    });

    return res.status(201).json({
      data: { id: rule.id, value: rule.displayValue, normalized: rule.customerExternalId, note: rule.note },
    });
  },
);

router.delete(
  "/exclusions/:id",
  authenticate,
  resolveTenant,
  requirePermission("channels:manage:update"),
  async (req: Request, res: Response) => {
    // deleteMany with the tenant in the filter: `delete` by id alone would
    // remove another workspace's rule on a guessed id.
    const removed = await prisma.inboundExclusion.deleteMany({
      where: { id: paramId(req), tenantId: req.tenantId! },
    });
    if (removed.count === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ data: { removed: removed.count } });
  },
);

// ─── Audit trail ─────────────────────────────────────────────

/**
 * Every step taken against one number, with Meta's own responses.
 *
 * Phase 10 requires showing the exact reason and the API response when
 * something fails. Bodies were redacted of anything token-shaped before being
 * stored, so this is safe to return.
 */
router.get(
  "/numbers/:id/events",
  authenticate,
  resolveTenant,
  requirePermission("channels:manage:read"),
  async (req: Request, res: Response) => {
    const owned = await prisma.whatsAppNumber.findFirst({
      where: { id: paramId(req), tenantId: req.tenantId! },
      select: { id: true },
    });
    if (!owned) return res.status(404).json({ error: "Number not found." });

    const events = await prisma.whatsAppNumberEvent.findMany({
      where: { numberId: owned.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return res.json({ data: events });
  },
);

export default router;
