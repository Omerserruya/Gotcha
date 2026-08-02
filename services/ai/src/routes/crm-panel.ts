/**
 * CRM panel routes - feed the conversation side panel from the tenant's CRM
 * and let the agent post manual notes during the interaction.
 *
 * Routes (all mounted under /api/crm):
 *   GET  /conversation/:id/context        - hydrate the panel (contact + activities)
 *   POST /conversation/:id/notes          - post a manual note from the panel
 *   POST /conversation/:id/sync-close     - close-of-conversation projection
 *                                            (summary + engagement) into CRM
 *
 * All routes resolve the customer via the existing `Contact` row attached to
 * the conversation (today's source of truth). When the migration adds
 * `GotchaPerson` + `CrmContactMapping` (Wave 1.11+), the resolution layer
 * switches over - these route bodies don't change.
 */

import { Router, type Request, type Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, resolveEffectiveLocale } from "@chatcenter/shared";
import { getCrmAdapter } from "../services/connectors/crm-adapter-resolver";
import {
  analyzeConversation,
  getConversationIntelligence,
} from "../services/conversation-intelligence.service";
import type { CrmObjectKind } from "../services/connectors/crm-adapter.types";
import {
  linkOrCreateCrmContact,
  type ChannelIdentity,
  type IdentityHints,
  type StrongChannel,
} from "../services/connectors/crm-identity.service";
import { loadCustomerContext } from "../services/memory/customer-context.service";

const router = Router();

// ─── Helpers ────────────────────────────────────────────────

interface ResolvedContact {
  contactId: string | null;
  /** CRM-side id when known (from prior find-or-create). */
  crmContactId: string | null;
  /** CRM-side object kind ("contact"|"lead"|...) when known. */
  crmObjectKind: CrmObjectKind | null;
  email: string | null;
  phone: string | null;
  displayName: string | null;
  channel: string;
  externalId: string;
}

function channelToStrong(channel: string | null | undefined): StrongChannel | null {
  const c = (channel || "").toLowerCase();
  switch (c) {
    case "whatsapp":  return "whatsapp";
    case "instagram": return "instagram";
    case "facebook":
    case "messenger": return "messenger";
    case "webchat":   return "webchat";
    case "voice":
    case "phone":     return "voice";
    case "sms":       return "sms";
    case "email":     return "email";
    default: return null;
  }
}

/**
 * Build the identity hints the CRM identity service uses to find/link/enrich.
 *
 * Strong identifiers we ship:
 *   - email + phone (the universal anchors)
 *   - per-channel external_id (PSID/IGSID/WA id) for cross-platform retrieval
 *   - username (Instagram @handle, FB profile name) - picked up from
 *     contact.metadata when the platform webhook captured it
 *   - display_name - for the create-lead path's First/Last name split
 *
 * Phone normalization needs a region hint when the source number is in local
 * format (e.g. `050-123-4567`). Tenant.metadata.defaultRegion would be the
 * right place; for v1 we read it off the contact metadata when present.
 */
function extractIdentityHints(resolved: ResolvedContact, contactMetadata: Record<string, any>): IdentityHints {
  const strong = channelToStrong(resolved.channel);
  const channels: ChannelIdentity[] = [];
  if (strong && resolved.externalId) {
    channels.push({
      channel: strong,
      external_id: resolved.externalId,
      username: typeof contactMetadata?.username === "string" ? contactMetadata.username : null,
      display_name: resolved.displayName,
      profile_url: typeof contactMetadata?.profileUrl === "string" ? contactMetadata.profileUrl : null,
    });
  }
  return {
    email: resolved.email,
    phone: resolved.phone,
    display_name: resolved.displayName,
    channels,
    default_region: typeof contactMetadata?.defaultRegion === "string" ? contactMetadata.defaultRegion : undefined,
  };
}

async function loadConversationContext(tenantId: string, conversationId: string): Promise<{ conv: any; resolved: ResolvedContact; contactMetadata: Record<string, any> } | null> {
  const conv = await (prisma as any).conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: {
      id: true,
      channel: true,
      customerExternalId: true,
      status: true,
      createdAt: true,
      closedAt: true,
      aiSummary: true,
    },
  });
  if (!conv) return null;

  // Map conversation → contact via (tenantId, channel, externalId).
  const contact = await (prisma as any).contact.findFirst({
    where: { tenantId, channel: conv.channel, externalId: conv.customerExternalId },
    select: {
      id: true,
      email: true,
      phone: true,
      displayName: true,
      metadata: true,
    },
  });

  const meta = (contact?.metadata ?? {}) as Record<string, any>;
  // crm linkage stored on contact.metadata for v1 (later: CrmContactMapping table).
  const crmContactId: string | null = meta?.crmContactId ?? null;
  const crmObjectKind: CrmObjectKind | null = meta?.crmObjectKind ?? null;

  return {
    conv,
    resolved: {
      contactId: contact?.id ?? null,
      crmContactId,
      crmObjectKind,
      email: contact?.email ?? null,
      phone: contact?.phone ?? null,
      displayName: contact?.displayName ?? null,
      channel: conv.channel,
      externalId: conv.customerExternalId,
    },
    contactMetadata: meta,
  };
}

/**
 * Build the funnel-aware active-stage payload for the CRM context envelope.
 *
 * Resolved by the same stage-resolver the live runner uses, so the
 * frontend stage progress card and the live cue copilot always agree on
 * which stage is active. Returns null when no funnel is configured or
 * we couldn't determine a stage - the frontend then hides the card.
 */
async function resolveActiveStagePayload(args: {
  tenantId: string;
  conversationId: string;
  departmentId: string | null;
}): Promise<{
  id: string;
  label: string;
  goal: string | null;
  source: "crm-match" | "crm-fallback-first" | "no-crm";
  vendor_stage: string | null;
  required_questions: Array<{ id: string; text: string; required: boolean }>;
  required_data_fields: Array<{ field: string; label: string; required: boolean }>;
  exit_criteria: {
    mustHaveFields: string[];
    mustAskQuestions: string[];
    positiveSignals: string[];
    negativeSignals: string[];
  } | null;
  next: { id: string; label: string } | null;
  /**
   * Every stage in the active funnel - populates the manual override
   * dropdown on the live workspace. Stages without `crmValue` are kept
   * (UI flags them as non-writable but still shows them for context).
   */
  all_stages: Array<{ id: string; label: string; crmValue: string | null }>;
} | null> {
  try {
    const { resolveActiveStage } = await import("../services/intelligence/stage-resolver.service");
    const r = await resolveActiveStage({
      tenantId: args.tenantId,
      conversationId: args.conversationId,
      departmentId: args.departmentId,
    });
    if (!r) return null;
    const copilot = r.stage.copilot;
    return {
      id: r.stage.id,
      label: r.stage.label,
      goal: copilot?.goal ?? null,
      source: r.source,
      vendor_stage: r.vendorStage,
      required_questions: (copilot?.requiredQuestions ?? []).map((q) => ({
        id: q.id,
        text: q.text,
        required: q.required,
      })),
      required_data_fields: (copilot?.requiredDataFields ?? []).map((f) => ({
        field: f.field,
        label: f.label,
        required: f.required,
      })),
      exit_criteria: copilot?.exitCriteria
        ? {
            mustHaveFields: copilot.exitCriteria.mustHaveFields ?? [],
            mustAskQuestions: copilot.exitCriteria.mustAskQuestions ?? [],
            positiveSignals: copilot.exitCriteria.positiveSignals ?? [],
            negativeSignals: copilot.exitCriteria.negativeSignals ?? [],
          }
        : null,
      next: r.nextStage
        ? { id: r.nextStage.id, label: r.nextStage.label }
        : null,
      all_stages: r.funnel.stages.map((s) => ({
        id: s.id,
        label: s.label,
        crmValue: s.crmValue ?? null,
      })),
    };
  } catch (err: any) {
    console.warn(
      "[crm-panel] resolveActiveStagePayload failed (non-fatal):",
      err?.message,
    );
    return null;
  }
}

/**
 * Cache the vendor's stage value onto Contact.metadata so the live-call
 * stage resolver can read it without re-calling the vendor adapter on
 * every turn. Called after each successful context fetch - best-effort,
 * never blocks the panel render.
 */
async function cacheCrmStageOnContact(args: {
  contactId: string | null;
  stage: string | null | undefined;
  vendor: string;
}): Promise<void> {
  if (!args.contactId || !args.stage) return;
  try {
    const row = await (prisma as any).contact.findUnique({
      where: { id: args.contactId },
      select: { metadata: true },
    });
    const meta = (row?.metadata ?? {}) as Record<string, any>;
    meta.crmStageCache = {
      value: args.stage,
      vendor: args.vendor,
      cachedAt: new Date().toISOString(),
    };
    await (prisma as any).contact.update({
      where: { id: args.contactId },
      data: { metadata: meta },
    });
  } catch (err: any) {
    console.warn(
      "[crm-panel] cacheCrmStageOnContact failed (non-fatal):",
      err?.message,
    );
  }
}

async function persistCrmLinkage(args: {
  tenantId: string;
  contactId: string;
  crmContactId: string;
  crmObjectKind: CrmObjectKind;
  vendor: string;
}): Promise<void> {
  // v1 stores the linkage on Contact.metadata. The migration's CrmContactMapping
  // table replaces this in a later step; that backfill reads metadata as input.
  const existing = await (prisma as any).contact.findUnique({
    where: { id: args.contactId },
    select: { metadata: true },
  });
  const meta = (existing?.metadata ?? {}) as Record<string, any>;
  meta.crmContactId = args.crmContactId;
  meta.crmObjectKind = args.crmObjectKind;
  meta.crmVendor = args.vendor;
  meta.crmLinkedAt = new Date().toISOString();
  await (prisma as any).contact.update({
    where: { id: args.contactId },
    data: { metadata: meta },
  });
}

async function auditCrmAction(args: {
  tenantId: string;
  conversationId: string;
  action: string;
  ok: boolean;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await (prisma as any).auditLog?.create?.({
      data: {
        tenantId: args.tenantId,
        actorType: "user",
        action: args.action,
        targetType: "conversation",
        targetId: args.conversationId,
        metadata: { ok: args.ok, ...(args.metadata || {}) },
      },
    });
  } catch (err: any) {
    console.warn("[crm-panel] audit failed:", err?.message);
  }
}

// ─── GET /api/crm/conversation/:id/context ─────────────────

router.get(
  "/conversation/:id/context",
  authenticate, resolveTenant, requireActiveTenant(),
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const conversationId = String(req.params.id);

    const loaded = await loadConversationContext(tenantId, conversationId);
    if (!loaded) {
      res.status(404).json({ error: "conversation_not_found" });
      return;
    }

    const adapter = await getCrmAdapter(tenantId);
    if (adapter.capabilities.is_stub && adapter.vendor === "custom_api") {
      // NoOp (no CRM connected) - return a minimal envelope so the panel can
      // render "Connect a CRM" call-to-action.
      res.json({
        data: {
          vendor: null,
          status: "no_crm_configured",
          contact: null,
          fallback: {
            displayName: loaded.resolved.displayName,
            email: loaded.resolved.email,
            phone: loaded.resolved.phone,
          },
        },
      });
      return;
    }

    const fallback = {
      displayName: loaded.resolved.displayName,
      email: loaded.resolved.email,
      phone: loaded.resolved.phone,
    };

    // 1. If we already have a crmContactId pinned on Contact.metadata, hydrate directly.
    if (loaded.resolved.crmContactId && loaded.resolved.crmObjectKind) {
      const ctx = await adapter.getCustomerContext({
        contact_id: loaded.resolved.crmContactId,
        kind: loaded.resolved.crmObjectKind,
      });
      if (ctx.ok && ctx.context) {
        // Open issues + recent summaries + CRM notes + activities - fail-soft
        // (never block the panel render). Loaded in parallel with the context
        // hydrate. We override `recent_activities` from the adapter's
        // getCustomerContext (which returns [] for all vendors today) with
        // the unified timeline the bundle assembles via listRecentActivities.
        const bundle = await loadCustomerContext({
          tenantId,
          conversationId,
          crmContactId: loaded.resolved.crmContactId,
          crmObjectKind: loaded.resolved.crmObjectKind,
          crmNoteLimit: 10,
        }).catch(() => null);
        // Cache vendor stage onto Contact.metadata so the live-call
        // stage resolver can read it cheaply during the next call.
        await cacheCrmStageOnContact({
          contactId: loaded.resolved.contactId,
          stage: ctx.context.contact?.stage ?? null,
          vendor: adapter.vendor,
        });
        // Resolve active funnel stage (uses the cache we just wrote).
        const activeStage = await resolveActiveStagePayload({
          tenantId,
          conversationId,
          departmentId: (loaded.conv as any).departmentId ?? null,
        });
        res.json({
          data: {
            vendor: adapter.vendor,
            status: "linked",
            ...ctx.context,
            open_issues: bundle?.open_issues ?? [],
            recent_summaries: bundle?.recent_summaries ?? [],
            recent_crm_notes: bundle?.recent_crm_notes ?? [],
            recent_activities: bundle?.recent_activities ?? ctx.context.recent_activities ?? [],
            sentiment_trend: bundle?.sentiment_trend ?? [],
            active_stage: activeStage,
            fallback,
          },
        });
        return;
      }
      // Linked but vendor returned not-found - fall through to identity service.
    }

    // 2. Identity service does the 0/1/2+ reconciliation. search_only because
    //    auto-creating on every panel open would be too aggressive - the
    //    operator clicks "Create lead" explicitly via POST /create-lead.
    const hints = extractIdentityHints(loaded.resolved, loaded.contactMetadata);
    const outcome = await linkOrCreateCrmContact({ adapter, hints, mode: "search_only" });

    if (outcome.status === "linked" || outcome.status === "merged" || outcome.status === "created") {
      const contact = outcome.contact;
      if (loaded.resolved.contactId) {
        await persistCrmLinkage({
          tenantId,
          contactId: loaded.resolved.contactId,
          crmContactId: contact.id,
          crmObjectKind: contact.kind,
          vendor: adapter.vendor,
        });
      }
      await auditCrmAction({
        tenantId, conversationId,
        action: `crm.link.${outcome.status}`,
        ok: true,
        metadata: {
          vendor: adapter.vendor,
          contact_id: contact.id,
          kind: contact.kind,
          was_enriched: outcome.status === "linked" ? outcome.was_enriched : undefined,
          merged_from: outcome.status === "merged" ? outcome.merged_from : undefined,
        },
      });
      const ctx = await adapter.getCustomerContext({ contact_id: contact.id, kind: contact.kind });
      const bundle = await loadCustomerContext({
        tenantId,
        conversationId,
        crmContactId: contact.id,
        crmObjectKind: contact.kind,
        crmNoteLimit: 10,
      }).catch(() => null);
      // Cache vendor stage (same rationale as the already-linked path).
      await cacheCrmStageOnContact({
        contactId: loaded.resolved.contactId,
        stage: ctx.ok && ctx.context ? ctx.context.contact?.stage ?? null : null,
        vendor: adapter.vendor,
      });
      const activeStage = await resolveActiveStagePayload({
        tenantId,
        conversationId,
        departmentId: (loaded.conv as any).departmentId ?? null,
      });
      res.json({
        data: {
          vendor: adapter.vendor,
          status: ctx.ok ? "linked" : "found_no_context",
          ...(ctx.ok && ctx.context ? ctx.context : { contact, recent_activities: [], deals: [], tickets: [] }),
          open_issues: bundle?.open_issues ?? [],
          recent_summaries: bundle?.recent_summaries ?? [],
          recent_crm_notes: bundle?.recent_crm_notes ?? [],
          recent_activities: bundle?.recent_activities ?? (ctx.ok && ctx.context ? ctx.context.recent_activities : []) ?? [],
          sentiment_trend: bundle?.sentiment_trend ?? [],
          active_stage: activeStage,
          link_meta: {
            outcome: outcome.status,
            was_enriched: outcome.status === "linked" ? outcome.was_enriched : undefined,
            merged_from: outcome.status === "merged" ? outcome.merged_from : undefined,
          },
          fallback,
        },
      });
      return;
    }

    if (outcome.status === "needs_approval") {
      await auditCrmAction({
        tenantId, conversationId,
        action: "crm.link.needs_approval",
        ok: false,
        metadata: { vendor: adapter.vendor, candidate_ids: outcome.candidates.map((c) => c.id), reason: outcome.reason },
      });
      res.json({
        data: {
          vendor: adapter.vendor,
          status: "needs_approval",
          contact: null,
          candidates: outcome.candidates,
          link_reason: outcome.reason,
          fallback,
        },
      });
      return;
    }

    // not_found OR error - both surface as "unmapped" so the UI can offer Create.
    res.json({
      data: {
        vendor: adapter.vendor,
        status: "unmapped",
        contact: null,
        link_reason: outcome.status === "error" ? outcome.reason : undefined,
        fallback,
      },
    });
  },
);

// ─── POST /api/crm/conversation/:id/create-lead ────────────
//
// Used when the panel shows "unmapped" - operator clicks "Create lead in CRM".

router.post(
  "/conversation/:id/create-lead",
  authenticate, resolveTenant, requireActiveTenant(),
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const conversationId = String(req.params.id);
    const loaded = await loadConversationContext(tenantId, conversationId);
    if (!loaded) {
      res.status(404).json({ error: "conversation_not_found" });
      return;
    }
    const adapter = await getCrmAdapter(tenantId);
    if (adapter.capabilities.is_stub && adapter.vendor === "custom_api") {
      res.status(409).json({ error: "no_crm_configured" });
      return;
    }

    const overrides = (req.body || {}) as Record<string, unknown>;
    const baseHints = extractIdentityHints(loaded.resolved, loaded.contactMetadata);
    // Operator overrides win when they typed them in the side panel.
    const hints: IdentityHints = {
      ...baseHints,
      email: (overrides.email as string | undefined) ?? baseHints.email,
      phone: (overrides.phone as string | undefined) ?? baseHints.phone,
      display_name: (overrides.display_name as string | undefined) ?? baseHints.display_name,
    };

    // Always go through the identity service - even on the explicit "create"
    // path - so we don't accidentally produce a duplicate when a row was
    // created between the panel's first context fetch and the operator click.
    const outcome = await linkOrCreateCrmContact({
      adapter,
      hints,
      mode: "create_if_missing",
      inbound_source: (overrides.source as string | undefined) ?? `GOTCHA ${loaded.resolved.channel}`,
      create_overrides: {
        company: overrides.company as string | undefined,
        first_name: overrides.first_name as string | undefined,
        last_name: overrides.last_name as string | undefined,
      },
    });

    await auditCrmAction({
      tenantId, conversationId,
      action: `crm.create_lead.${outcome.status}`,
      ok: outcome.status === "created" || outcome.status === "linked" || outcome.status === "merged",
      metadata: {
        vendor: adapter.vendor,
        outcome: outcome.status,
        contact_id: outcome.status === "created" || outcome.status === "linked" || outcome.status === "merged" ? outcome.contact.id : undefined,
        reason: outcome.status === "error" || outcome.status === "needs_approval" || outcome.status === "not_found" ? outcome.reason : undefined,
        candidate_ids: outcome.status === "needs_approval" ? outcome.candidates.map((c) => c.id) : undefined,
      },
    });

    if (outcome.status === "needs_approval") {
      res.status(409).json({
        error: "multiple_candidates",
        candidates: outcome.candidates,
        reason: outcome.reason,
      });
      return;
    }

    if (outcome.status === "not_found" || outcome.status === "error") {
      res.status(502).json({ error: outcome.reason ?? "create_failed" });
      return;
    }

    // created | linked | merged → pin the linkage and return the canonical row.
    const contact = outcome.contact;
    if (loaded.resolved.contactId) {
      await persistCrmLinkage({
        tenantId,
        contactId: loaded.resolved.contactId,
        crmContactId: contact.id,
        crmObjectKind: contact.kind,
        vendor: adapter.vendor,
      });
    }
    res.json({
      data: {
        vendor: adapter.vendor,
        crm_contact_id: contact.id,
        kind: contact.kind,
        outcome: outcome.status,
        was_enriched: outcome.status === "linked" ? outcome.was_enriched : undefined,
        merged_from: outcome.status === "merged" ? outcome.merged_from : undefined,
      },
    });
  },
);

// ─── POST /api/crm/conversation/:id/pick-candidate ─────────
//
// Operator resolution path for the "needs_approval" state. When the identity
// service finds 2+ CRM candidates and can't safely merge, the panel surfaces
// the list; the operator picks one and we pin the linkage. No merge happens -
// the unselected duplicates stay in the CRM and the operator can clean them
// up in the vendor UI.

router.post(
  "/conversation/:id/pick-candidate",
  authenticate, resolveTenant, requireActiveTenant(),
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const conversationId = String(req.params.id);
    const crmContactId = String(req.body?.crm_contact_id ?? "").trim();
    const kindRaw = String(req.body?.kind ?? "").trim();
    if (!crmContactId) { res.status(400).json({ error: "crm_contact_id_required" }); return; }
    const validKinds: CrmObjectKind[] = ["contact", "lead", "person_account", "organization_member", "company"];
    if (!validKinds.includes(kindRaw as CrmObjectKind)) {
      res.status(400).json({ error: "invalid_kind" });
      return;
    }
    const kind = kindRaw as CrmObjectKind;

    const loaded = await loadConversationContext(tenantId, conversationId);
    if (!loaded) { res.status(404).json({ error: "conversation_not_found" }); return; }
    const adapter = await getCrmAdapter(tenantId);
    if (adapter.capabilities.is_stub && adapter.vendor === "custom_api") {
      res.status(409).json({ error: "no_crm_configured" });
      return;
    }

    // Verify the candidate still exists on the CRM side before pinning.
    const ctx = await adapter.getCustomerContext({ contact_id: crmContactId, kind });
    if (!ctx.ok || !ctx.context) {
      res.status(404).json({ error: ctx.reason ?? "candidate_not_found" });
      return;
    }

    if (loaded.resolved.contactId) {
      await persistCrmLinkage({
        tenantId,
        contactId: loaded.resolved.contactId,
        crmContactId,
        crmObjectKind: kind,
        vendor: adapter.vendor,
      });
    }
    await auditCrmAction({
      tenantId, conversationId,
      action: "crm.pick_candidate.ok",
      ok: true,
      metadata: { vendor: adapter.vendor, crm_contact_id: crmContactId, kind },
    });
    res.json({ data: { vendor: adapter.vendor, crm_contact_id: crmContactId, kind } });
  },
);

// ─── POST /api/crm/conversation/:id/notes ──────────────────

router.post(
  "/conversation/:id/notes",
  authenticate, resolveTenant, requireActiveTenant(),
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const conversationId = String(req.params.id);
    const body = String((req.body?.body ?? "")).trim();
    if (!body) { res.status(400).json({ error: "body_required" }); return; }
    if (body.length > 5000) { res.status(400).json({ error: "body_too_long" }); return; }

    const loaded = await loadConversationContext(tenantId, conversationId);
    if (!loaded) { res.status(404).json({ error: "conversation_not_found" }); return; }
    if (!loaded.resolved.crmContactId || !loaded.resolved.crmObjectKind) {
      res.status(409).json({ error: "no_crm_link" });
      return;
    }

    const adapter = await getCrmAdapter(tenantId);
    if (adapter.capabilities.is_stub && adapter.vendor === "custom_api") {
      res.status(409).json({ error: "no_crm_configured" });
      return;
    }

    const result = await adapter.createNote({
      contact_id: loaded.resolved.crmContactId,
      kind: loaded.resolved.crmObjectKind,
      body,
      source_interaction_id: conversationId,
      payload_version: 1,
    });

    await auditCrmAction({
      tenantId, conversationId,
      action: result.ok ? "crm.note.create.ok" : "crm.note.create.err",
      ok: result.ok,
      metadata: { vendor: adapter.vendor, reason: result.reason, body_length: body.length },
    });

    if (!result.ok) { res.status(502).json({ error: result.reason ?? "note_create_failed" }); return; }
    res.json({ data: { vendor: adapter.vendor, note_id: result.id ?? null, was_update: result.was_update ?? false } });
  },
);

// ─── POST /api/crm/conversation/:id/sync-close ─────────────
//
// Idempotent close-of-interaction sync. Generates / fetches the
// ConversationIntelligence summary, builds an engagement envelope, and pushes
// it as a CRM activity (HubSpot Note / Salesforce Task / Zoho Note).
//
// Called from:
//   • Manual close path (frontend "End conversation" button)
//   • idle-conversation worker (later - for now synchronous from the manual
//     route)
//   • flow-executor 'end' node (later)
//
// For v1 this is synchronous and best-effort: a failure does NOT block the
// close. Future: the outbox pattern decouples this fully.

export interface CrmSyncCloseResult {
  status: "ok" | "not_found" | "skipped";
  synced: boolean;
  vendor?: string;
  crm_activity_id?: string | null;
  reason?: string;
  recovery_status?: string;
}

/**
 * Project the just-closed conversation as an activity into the tenant's CRM.
 * Idempotent: re-running on the same conversation reuses the existing
 * intelligence row (or generates it if missing) and the CRM adapter's
 * appendInteraction is itself idempotent on source_interaction_id.
 *
 * Callable from:
 *   • the manual sync-close route (frontend "End conversation" button)
 *   • the post-chat subscriber (bot- and idle-closed conversations)
 *   • flow-executor 'end' node (future)
 */
export async function syncCloseToCrm(
  tenantId: string,
  conversationId: string,
): Promise<CrmSyncCloseResult> {
  // Idempotency guard. The manual "End conversation" button and the
  // conversation:closed event subscriber both fire syncCloseToCrm - without
  // this check the CRM gets two activity notes ~2s apart (different LLM
  // wording each time because the summarizer ran twice). 5-min window is
  // long enough to absorb the race but short enough that an operator who
  // intentionally re-runs the sync later still gets a fresh note.
  try {
    const recent = await (prisma as any).auditLog?.findFirst?.({
      where: {
        tenantId,
        action: "crm.sync_close.ok",
        targetType: "conversation",
        targetId: conversationId,
        createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      },
      select: { id: true },
    });
    if (recent) {
      console.log(`[crm-sync-close] skip reason=already_synced conv=${conversationId} tenant=${tenantId}`);
      return { status: "skipped", synced: false, reason: "already_synced" };
    }
  } catch (err: any) {
    console.warn("[crm-sync-close] dedup-check failed (proceeding):", err?.message);
  }

  const loaded = await loadConversationContext(tenantId, conversationId);
  if (!loaded) return { status: "not_found", synced: false };

  const adapter = await getCrmAdapter(tenantId);
  if (adapter.capabilities.is_stub && adapter.vendor === "custom_api") {
    console.log(`[crm-sync-close] skip reason=no_crm_configured conv=${conversationId} tenant=${tenantId}`);
    return { status: "skipped", synced: false, reason: "no_crm_configured" };
  }

  // Self-heal: if the panel was never opened (or the link wasn't persisted),
  // run identity lookup now so close-of-conversation still hits the CRM.
  //
  // Auto-create policy: when the conversation has at least one strong
  // identifier (phone or email - including the channel-derived phone for
  // WhatsApp/SMS/voice), promote the recovery to `create_if_missing`. This
  // turns the agent-back-office into a system job: an inbound or outbound
  // call closing with a known number always lands in the CRM as a lead,
  // and the summarizer's `crm_patch` then enriches it with whatever else
  // came up in the call. Anonymous callers (no phone, no email - e.g.
  // blocked caller-ID) still skip - creating empty leads is just noise.
  if (!loaded.resolved.crmContactId || !loaded.resolved.crmObjectKind) {
    console.log(
      `[crm-sync-close] missing_link conv=${conversationId} tenant=${tenantId} ` +
      `contactId=${loaded.resolved.contactId ?? "null"} channel=${loaded.resolved.channel} ` +
      `externalId=${loaded.resolved.externalId} - attempting identity recovery`,
    );
    const hints = extractIdentityHints(loaded.resolved, loaded.contactMetadata);
    const hasStrongId =
      Boolean(hints.phone) ||
      Boolean(hints.email) ||
      (hints.channels ?? []).some(
        (c) =>
          (c.channel === "whatsapp" || c.channel === "sms" || c.channel === "voice" || c.channel === "email") &&
          Boolean(c.external_id),
      );
    const recoveryMode: "search_only" | "create_if_missing" = hasStrongId ? "create_if_missing" : "search_only";
    console.log(
      `[crm-sync-close] recovery_mode=${recoveryMode} hasStrongId=${hasStrongId} ` +
      `hasPhone=${Boolean(hints.phone)} hasEmail=${Boolean(hints.email)} ` +
      `hasName=${Boolean(hints.display_name)}`,
    );
    const outcome = await linkOrCreateCrmContact({ adapter, hints, mode: recoveryMode });
    const recovered =
      outcome.status === "linked" ||
      outcome.status === "merged" ||
      outcome.status === "created";
    if (!recovered) {
      console.warn(
        `[crm-sync-close] recovery_failed conv=${conversationId} status=${outcome.status} - skipping`,
      );
      return { status: "skipped", synced: false, reason: "no_crm_link", recovery_status: outcome.status };
    }
    if (loaded.resolved.contactId) {
      await persistCrmLinkage({
        tenantId,
        contactId: loaded.resolved.contactId,
        crmContactId: outcome.contact.id,
        crmObjectKind: outcome.contact.kind,
        vendor: adapter.vendor,
      });
    } else {
      console.log(
        `[crm-sync-close] recovered link without local contact - proceeding without persistCrmLinkage ` +
        `conv=${conversationId} crm_contact_id=${outcome.contact.id}`,
      );
    }
    loaded.resolved.crmContactId = outcome.contact.id;
    loaded.resolved.crmObjectKind = outcome.contact.kind;
    console.log(
      `[crm-sync-close] recovered link vendor=${adapter.vendor} ` +
      `crm_contact_id=${outcome.contact.id} kind=${outcome.contact.kind}`,
    );
  }

  let intel = await getConversationIntelligence(tenantId, conversationId).catch(() => null);
  if (!intel) {
    try { await analyzeConversation(tenantId, conversationId); }
    catch (err: any) { console.warn("[crm-panel] analyzeConversation failed:", err?.message); }
    intel = await getConversationIntelligence(tenantId, conversationId).catch(() => null);
  }

  const messageCount = await (prisma as any).message.count({ where: { tenantId, conversationId } });
  const startedAt = loaded.conv.createdAt ? new Date(loaded.conv.createdAt) : null;
  const endedAt = loaded.conv.closedAt ? new Date(loaded.conv.closedAt) : new Date();
  const durationSeconds = startedAt && endedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : undefined;

  // A conversation summary is an INBOUND engagement whenever the customer
  // actually participated (sent at least one message) - which is the normal
  // case. The previous "first message direction" heuristic mislabeled the whole
  // chat as OUTBOUND just because a flow/agent sent the opening greeting first.
  // Only a conversation with NO inbound message at all (pure outbound blast)
  // stays outbound.
  const inboundCount = await (prisma as any).message.count({
    where: { tenantId, conversationId, direction: "INBOUND" },
  });
  const direction: "inbound" | "outbound" = inboundCount > 0 ? "inbound" : "outbound";

  const summary = (intel as any)?.summary ?? loaded.conv.aiSummary ?? null;
  const crmContactId = loaded.resolved.crmContactId!;
  const crmObjectKind = loaded.resolved.crmObjectKind!;
  // Resolve the tenant's effective system language so the CRM note labels
  // ("Duration:", "Summary:", …) match the summary text the LLM wrote
  // earlier. Failure → fall back to "en" inside renderInteractionBody.
  const noteLocale = await resolveEffectiveLocale({ tenantId })
    .then((r) => r.effective)
    .catch(() => undefined);
  const result = await adapter.appendInteraction({
    contact_id: crmContactId,
    kind: crmObjectKind,
    interaction: {
      source_interaction_id: conversationId,
      channel: (String(loaded.conv.channel || "").toLowerCase() as any) || "webchat",
      direction,
      started_at: startedAt?.toISOString() ?? new Date().toISOString(),
      ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds,
      message_count: messageCount,
      summary: summary ?? undefined,
      engagement: {
        sentiment: (intel as any)?.sentiment ?? null,
        qualification: (intel as any)?.qualification ?? null,
        action_items: Array.isArray((intel as any)?.actionItems) ? (intel as any).actionItems : [],
      },
      locale: noteLocale,
    },
    payload_version: 1,
  });

  console.log(
    `[crm-sync-close] result conv=${conversationId} vendor=${adapter.vendor} ` +
    `ok=${result.ok} crm_activity_id=${result.id ?? "null"} reason=${result.reason ?? "n/a"} ` +
    `crm_contact_id=${loaded.resolved.crmContactId} kind=${loaded.resolved.crmObjectKind} ` +
    `duration=${durationSeconds}s msgs=${messageCount} summary=${Boolean(summary)}`,
  );

  await auditCrmAction({
    tenantId, conversationId,
    action: result.ok ? "crm.sync_close.ok" : "crm.sync_close.err",
    ok: result.ok,
    metadata: {
      vendor: adapter.vendor,
      reason: result.reason,
      durationSeconds, messageCount, hadSummary: Boolean(summary),
    },
  });

  return {
    status: "ok",
    synced: result.ok,
    vendor: adapter.vendor,
    crm_activity_id: result.id ?? null,
    reason: result.reason,
  };
}

router.post(
  "/conversation/:id/sync-close",
  authenticate, resolveTenant, requireActiveTenant(),
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const conversationId = String(req.params.id);

    const out = await syncCloseToCrm(tenantId, conversationId);
    if (out.status === "not_found") { res.status(404).json({ error: "conversation_not_found" }); return; }
    if (out.status === "skipped") {
      res.json({ data: { synced: false, reason: out.reason, recovery_status: out.recovery_status } });
      return;
    }
    res.json({
      data: {
        synced: out.synced,
        vendor: out.vendor,
        crm_activity_id: out.crm_activity_id ?? null,
        reason: out.reason,
      },
    });
  },
);

export default router;
