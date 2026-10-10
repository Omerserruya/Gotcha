import { reportOperationalFailure, ERROR_CODES } from "@chatcenter/shared";
import { Router, Request, Response } from "express";
import { enableReadToolsForIntegration } from "../services/integration-provisioning.service";
import { prisma, authenticate, resolveTenant, requireOnboardingOrActiveTenant, requirePermission, requirePermissionOrRole, encryptCredentials, decryptCredentials, searchLeads as crmSearchLeads, searchContacts as crmSearchContacts, readDurableSetting, writeDurableSetting } from "@chatcenter/shared";

/** Where the chosen use case lives. A tenant setting, so no migration. */
const BUSINESS_MODEL_KEY = "businessModel";
import { executeAdapterTool, getAdapter, clearMissingScopes, capabilityStateFromConfig } from "../services/connectors/integration-framework";
import { invalidateCrmAdapterCache, getCrmAdapter, resolveCrmVendor } from "../services/connectors/crm-adapter-resolver";
import { maskPhone, maskEmail } from "../lib/mask";
import { tryEmit } from "../services/notifications-emit";
import { getSourceOfTruth, type SourceOfTruthCapability } from "../services/connectors/source-of-truth";
import {
  BUSINESS_ROLES,
  ROLES_FOR_USE_CASE,
  candidatesForRole,
  roleAvailability,
  isUseCase,
  isBusinessRole,
  rolesFor,
  planRoleElection,
} from "../services/connectors/business-roles";
import { getBusinessCoreMap } from "../services/connectors/part-systems";
import { readerLocale } from "../lib/reader-locale";
import { catalogDescription } from "../lib/catalog-descriptions";
import { catalogTool } from "../lib/catalog-tools-he";
import { splitErrorCode } from "../lib/error-code";
import { probeConnectCredentials } from "../services/connect-probe";

const router = Router();

// PENDING_ONBOARDING tenants may browse and connect the marketplace too - the
// setup wizard's integrations movement matches detected tools against this
// catalog and offers real connects. requireActiveTenant() 403'd during
// onboarding, which made EVERY detected tool (ReturnGO included) render as
// "not supported yet" because the catalog fetch came back empty.
// Authorization is permission-based (Active Membership), never Role==ADMIN.
// This router serves BOTH the AI Studio marketplace (integrations:*) and
// Settings → Business Systems (business-systems:*), so gates accept either
// domain's key. The router-level gate is the READ floor; mutating routes add
// stronger per-route gates below.
const canReadSystems = requirePermission("integrations:connections:read", "business-systems:connections:read");

/**
 * Bound what a connection row hands back.
 *
 * `lastError` is the platform's own text, and one of the write paths truncates
 * it to 200 while others do not - the shopify row on dev is 255 characters and
 * opens with `<!DOCTYPE html>`, which is a provider returning an HTML error
 * page rather than JSON. Truncating only on write means the cap depends on
 * which code path failed; doing it here makes the served field bounded whatever
 * produced it, including rows written before any cap existed.
 *
 * Not sanitised beyond length: the text is shown to an admin as the platform
 * said it, because a paraphrased provider error is a worse debugging aid than
 * an ugly one.
 */
const LAST_ERROR_MAX = 200;
function boundConnection<T extends { lastError?: string | null }>(row: T | undefined): (T & { lastErrorCode: string | null }) | null {
  if (!row) return null;
  // The code a writer stored beside the sentence (lib/error-code), served apart.
  const { lastError, lastErrorCode } = splitErrorCode(row.lastError);
  const bounded = typeof lastError === "string" && lastError.length > LAST_ERROR_MAX ? lastError.slice(0, LAST_ERROR_MAX) : lastError;
  return { ...row, lastError: bounded, lastErrorCode };
}
const canConnectSystems = requirePermission("integrations:connections:connect", "business-systems:connections:connect");
const canManageSystems = requirePermission("integrations:connections:disconnect", "business-systems:connections:manage");
const canSelectSot = requirePermission("business-systems:sot:select");
router.use(authenticate, resolveTenant, requireOnboardingOrActiveTenant(), canReadSystems);

// GET / - List all published catalog integrations with tenant connection status
router.get("/", async (req: Request, res: Response) => {
  try {
    const catalog = await prisma.integrationCatalog.findMany({
      where: { isPublished: true },
      include: {
        catalogTools: {
          select: {
            id: true,
            name: true,
            slug: true,
            riskLevel: true,
            tenantTools: {
              where: { tenantId: req.tenantId! },
              select: { id: true, isEnabled: true },
            },
          },
          orderBy: { name: "asc" },
        },
        tenantConnections: {
          where: { tenantId: req.tenantId! },
          // `config` carries non-secret per-tenant settings (useAsCrm,
          // shopDomain, …) and the detail route already returns it. Without it
          // here, list consumers cannot tell an elected customer system of
          // record from a plain connection: the Settings toggle rendered OFF
          // for a tenant whose config.useAsCrm was true. `credentials` stays
          // out - it is the encrypted secret and no list view needs it.
          //
          // The three health columns are written by /test in six places and,
          // until now, read by nothing: a client could learn status ERROR but
          // never WHEN it broke or WHY. Both of those are what the failure
          // banner says out loud.
          //
          // `lastTestedAt` is a CONNECTION TEST and nothing else. There is no
          // sync concept for integrations anywhere in this system - nothing
          // records "pulled N records at T" - so this must never be surfaced
          // or renamed as "last synced". It would tell a customer their data
          // is current when all that happened is a credential check passing,
          // which is wrong in the reassuring direction.
          select: {
            id: true,
            status: true,
            createdAt: true,
            config: true,
            lastTestedAt: true,
            lastTestResult: true,
            lastError: true,
          },
        },
      },
      orderBy: { sortOrder: "asc" },
    });

    const locale = await readerLocale(req);
    const data = catalog.map((entry) => ({
      ...entry,
      description: catalogDescription(entry.slug, entry.description, locale),
      catalogTools: entry.catalogTools.map((ct: any) => ({
        ...catalogTool(entry.slug, ct, locale),
        tenantTool: ct.tenantTools?.[0] || null,
        tenantTools: undefined,
      })),
      authType: entry.authType,
      authSchema: entry.authSchema,
      tenantConnection: boundConnection(entry.tenantConnections[0]),
      tenantConnections: undefined,
    }));

    res.json({ data });
  } catch (err) {
    console.error("List catalog integrations error:", err);
    res.status(500).json({ error: "Failed to list integrations" });
  }
});

/**
 * GET /commerce/capabilities — can this WORKSPACE act on orders at all?
 *
 * The same flags already exist on /api/commerce-context/:conversationId, but
 * that endpoint is scoped to one conversation, so there was no way to ask the
 * question Go live actually turns on: not "may this agent refund this order"
 * but "has this store granted us refunds in the first place". Registered
 * BEFORE /:slug so the literal path wins.
 *
 * These are the STORE's grants, not the reader's permissions. A viewer with no
 * refund permission still needs a truthful answer about whether the workspace
 * could refund, because that is what the setup screen is reporting on.
 *
 * `probed: false` means no successful probe has ever run for this store. It is
 * NOT "the store granted nothing" and must never be rendered as a capability
 * of no - the honest reading is that we do not know yet, and the screen shows
 * a reconnect prompt rather than a red cross.
 */
const COMMERCE_SCOPE_FOR: Record<string, string[]> = {
  readOrders: ["read_orders"],
  refund: ["write_orders"],
  cancel: ["write_orders"],
  track: ["read_fulfillments"],
};

router.get("/commerce/capabilities", async (req: Request, res: Response) => {
  try {
    const connection = await prisma.tenantIntegration.findFirst({
      where: {
        tenantId: req.tenantId!,
        status: "CONNECTED",
        integration: { category: "ECOMMERCE" },
      },
      select: { config: true, integration: { select: { slug: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });

    if (!connection) {
      // No commerce system is a real, common state - not an error, and not a
      // set of capabilities that are all false, which would read as "connected
      // but forbidden".
      res.json({ data: { connected: false, provider: null, probed: false, can: null } });
      return;
    }

    const state = capabilityStateFromConfig(connection.config as Record<string, unknown> | null);
    const granted = new Set(state.grantedScopes);
    const probed = state.grantedScopes.length > 0 || state.lastCheckedAt !== null;

    const can: Record<string, boolean> = {};
    for (const [capability, scopes] of Object.entries(COMMERCE_SCOPE_FOR)) {
      can[capability] = scopes.every((sc) => granted.has(sc));
    }

    res.json({
      data: {
        connected: true,
        provider: connection.integration.slug,
        probed,
        lastCheckedAt: state.lastCheckedAt,
        grantedScopes: state.grantedScopes,
        can,
      },
    });
  } catch (err) {
    console.error("Commerce capabilities error:", err);
    res.status(500).json({ error: "Failed to resolve commerce capabilities" });
  }
});

// ─── Business core (screen 14) ───────────────────────────────

/**
 * GET /business-core - the use case, and which system serves each part.
 *
 * The election mechanism this builds on is already capability-honest and already
 * SEPARATE FROM CONNECTING: a tenant elects by flagging an integration it has
 * already connected. So this endpoint never connects anything - it reports the
 * parts, who can serve each, and who currently does. Connecting stays in the
 * marketplace, which is the duplication the design wanted removed.
 *
 * ★ A PART WITH NO POSSIBLE SYSTEM SAYS SO. `shipping` has a category and zero
 * integrations, so its list is empty for every tenant forever. Reported as
 * `available: false` with a reason rather than an empty array, because "nothing
 * exists to choose" and "nothing connected yet" need different sentences and an
 * empty list reads as the second.
 *
 * Storage needs no migration: the use case is a durable tenant setting, and a
 * role election lives on `TenantIntegration.config.roles` - the same place
 * `config.useAsCrm` already elects the CRM.
 */
router.get("/business-core", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const [rawUseCase, catalogue, connected, partMap] = await Promise.all([
      readDurableSetting(tenantId, BUSINESS_MODEL_KEY),
      prisma.integrationCatalog.findMany({
        where: { isPublished: true },
        select: { slug: true, name: true, category: true, canActAsCrm: true },
      }),
      prisma.tenantIntegration.findMany({
        where: { tenantId },
        select: { status: true, config: true, integration: { select: { slug: true, name: true } } },
      }),
      getBusinessCoreMap(tenantId),
    ]);

    const useCase = isUseCase(rawUseCase) ? rawUseCase : null;
    const catalogueRows = catalogue.map((c) => ({ ...c, category: String(c.category) }));
    // ★ STATUS, NOT PRESENCE. A TenantIntegration row exists for anything a
    // tenant has ever started connecting, including one sitting in ERROR - and
    // reporting that as "connected" is the reassuring direction: the screen would
    // offer a system as ready while the election endpoint refuses it, and the
    // merchant would have no way to see why.
    //
    // Three states, not two: connected, never connected, and connected-but-
    // failing. The raw status travels so the screen can say which.
    const statusBySlug = new Map(connected.map((c) => [c.integration.slug, String(c.status)]));

    const roles = (useCase ? ROLES_FOR_USE_CASE[useCase] : BUSINESS_ROLES).map((role) => {
      const availability = roleAvailability(role);
      const candidates = candidatesForRole(role, catalogueRows).map((slug) => {
        const row = catalogueRows.find((c) => c.slug === slug)!;
        const status = statusBySlug.get(slug) ?? null;
        return {
          slug,
          name: row.name,
          // Only a CONNECTED row may be elected, and the write enforces the same
          // thing - so this cannot claim a system the write would refuse.
          connected: status === "CONNECTED",
          // null = never connected. Any other value = a row exists and is not
          // usable yet, which needs a different sentence from "not connected".
          status,
        };
      });

      // ★ READ THROUGH THE SAME FACADE THE AI USES, so the screen cannot show a
      // system the model does not resolve to. Each part delegates to whichever
      // elector its consumer already reads - the CRM resolver, the returns
      // resolver, or `config.roles` for the parts that had none.
      const resolved = partMap.find((m) => m.part === role)!;
      const electedRow = resolved.slug
        ? catalogueRows.find((c) => c.slug === resolved.slug) ?? null
        : null;

      // ★ TWO DIFFERENT FACTS USED TO SHARE `reason`, AND THE PROSE WON.
      // `...availability` spread the enum `reason: "no_integrations_exist"`, and
      // `reason: resolved.reason` then overwrote it with a sentence. Nothing
      // broke - `available` and `detail` both survived, so the screen still told
      // "nothing exists to choose" from "nothing connected yet" - but the enum
      // became unobtainable, and a consumer trusting the documented meaning got
      // prose where a code is specified.
      //
      // So the availability code travels as `unavailableReason` and `reason`
      // keeps the prose it already carried. ADD-ONLY, deliberately: the
      // available/detail shape is byte-identical to before, because the
      // consumer's contract is a strict `z.object` and nulling or removing a key
      // is what broke the voice screen when `basis.messagesAnalysed` went from
      // 0 to null. An unexpected key is stripped; a changed type is refused.
      const availabilityFields = availability.available
        ? { available: true as const }
        : {
            available: false as const,
            detail: availability.detail,
            unavailableReason: availability.reason,
          };

      return {
        role,
        ...availabilityFields,
        elected: resolved.slug ? { slug: resolved.slug, name: electedRow?.name ?? resolved.slug } : null,
        // WHY it is that system: chosen by the merchant, inferred by a resolver,
        // or not set. "Inferred" must not read as a decision somebody made.
        source: resolved.source,
        // Prose, always present. The availability CODE is `unavailableReason`.
        reason: resolved.reason,
        // The same why as a code (and the values it names), for a screen to
        // word in its own language. Add-only: `reason` keeps its prose.
        reasonCode: resolved.reasonCode,
        reasonParams: resolved.reasonParams ?? {},
        candidates,
      };
    });

    res.json({
      data: {
        useCase,
        roles,
        // Named so a screen can show the two facts the catalogue cannot express,
        // rather than each client rediscovering them. See business-roles.ts.
        catalogueNotes: [
          "The shipping category exists and contains no integrations, so that part cannot be offered yet.",
          "ReturnGo is stored under the ecommerce category but serves returns, and is listed under returns here.",
        ],
        // The same two facts as codes, in the same order, for a screen to word.
        // Beside the sentences, not instead: a strict client refuses a changed type.
        catalogueNoteCodes: ["shipping_category_empty", "returngo_listed_under_returns"],
      },
    });
  } catch (err) {
    console.error("business-core read error:", err);
    res.status(500).json({ error: "Failed to read the business core" });
  }
});

/**
 * PUT /business-core/role - choose which connected system serves one part.
 *
 * ★ THIS IS THE WRITE MY OWN READ SIDE IMPLIED AND DID NOT HAVE. `GET
 * /business-core` reported who serves each part, and nothing in the monorepo
 * ever wrote `config.roles` - 32 tenantIntegration writes, none of them this one.
 * So a five-part dropdown would have saved for the CRM and silently done nothing
 * for the other four: a control that looks configurable and is not, which is the
 * failure this codebase keeps finding and I had just built a fresh one of.
 *
 * ── It ELECTS, it does not connect ──
 *
 * Only an already-CONNECTED integration can be chosen. Connecting stays in the
 * marketplace; this is a dropdown over what a tenant already has.
 *
 * ── It DISPLACES, and says what it replaced ──
 *
 * One system per part is the rule. Refusing when a part is taken would recreate
 * the undeletable-employee trap: the merchant is blocked by a state they cannot
 * see and did not know about. Silent displacement is the reassuring direction. So
 * the write succeeds and the response NAMES the incumbent, which is the only way
 * a screen can say "it was Shopify".
 *
 * ── The CRM part is NOT electable here, deliberately ──
 *
 * `config.useAsCrm` and its resolver already elect the customer system of record,
 * and the GET reads that resolver so this screen cannot disagree with the system
 * the bot actually calls. A second way to elect a CRM would be two sources for
 * one decision - the shape that has cost this repo a day already. Refused with a
 * pointer to the one path.
 *
 * ── A part that cannot be served is refused, not stored ──
 *
 * `shipping` has a category and zero integrations, so the GET reports
 * `available: false`. Accepting an election for it would store something the read
 * will immediately contradict.
 */
router.put("/business-core/role", canSelectSot, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const role = body.role;
  const slug = body.slug;

  if (!isBusinessRole(role)) {
    res.status(422).json({ error: `role must be one of: ${BUSINESS_ROLES.join(", ")}` });
    return;
  }
  if (role === "crm") {
    res.status(409).json({
      error: "The CRM is elected through PUT /api/integrations/:slug/crm-source, which is the one path for it",
      code: "CRM_ELECTED_ELSEWHERE",
    });
    return;
  }
  if (role === "returns") {
    // ★ SAME REASON AS THE CRM, discovered later. `config.returnProvider` is
    // already the explicit switch for returns and `getReturnProvider` already
    // reads it in the AI's decision path - "explicit selection wins over
    // inference", in its own words. Writing `config.roles` here instead would
    // store the merchant's choice where nothing reads it while the AI kept
    // resolving returns from capabilities. One elector per part, and for this
    // part it already exists.
    res.status(409).json({
      error: "Returns are elected through config.returnProvider, which the AI already reads. Use that switch.",
      code: "RETURNS_ELECTED_ELSEWHERE",
    });
    return;
  }
  const availability = roleAvailability(role);
  if (!availability.available) {
    res.status(409).json({ error: availability.detail, code: availability.reason.toUpperCase() });
    return;
  }
  // `null` clears the part rather than electing anything - a merchant saying
  // "nothing serves this" is a real answer and distinct from never choosing.
  if (slug !== null && typeof slug !== "string") {
    res.status(422).json({ error: "slug must be an integration slug, or null to clear the part" });
    return;
  }

  try {
    const tenantId = req.tenantId!;
    const connected = await prisma.tenantIntegration.findMany({
      where: { tenantId },
      select: { id: true, status: true, config: true, integration: { select: { slug: true, name: true, category: true, canActAsCrm: true } } },
    });

    let elect: (typeof connected)[number] | null = null;
    if (slug !== null) {
      elect = connected.find((c) => c.integration.slug === slug) ?? null;
      if (!elect) {
        res.status(404).json({ error: "Connect that system first - this screen chooses between systems you already have" });
        return;
      }
      if (elect.status !== "CONNECTED") {
        res.status(409).json({ error: "That system must be connected before it can serve a part of your business" });
        return;
      }
      const can = rolesFor(elect.integration.slug, {
        canActAsCrm: elect.integration.canActAsCrm,
        category: String(elect.integration.category),
      });
      if (!can.includes(role)) {
        // Refused rather than stored: the GET derives candidates from the same
        // map, so storing this would produce an elected system the read does not
        // list as a candidate for the part.
        res.status(409).json({ error: `${elect.integration.name} cannot serve ${role}`, code: "ROLE_NOT_SUPPORTED" });
        return;
      }
    }

    const electable = connected.map((c) => {
      const cfg = (c.config && typeof c.config === "object" ? c.config : {}) as Record<string, unknown>;
      return {
        id: c.id,
        slug: c.integration.slug,
        name: c.integration.name,
        status: String(c.status),
        roles: Array.isArray(cfg.roles) ? (cfg.roles as unknown[]).filter((r): r is string => typeof r === "string") : [],
      };
    });

    const plan = planRoleElection(role, slug, electable);
    for (const w of plan.writes) {
      const row = connected.find((c) => c.id === w.id)!;
      const cfg = (row.config && typeof row.config === "object" ? row.config : {}) as Record<string, unknown>;
      cfg.roles = w.roles;
      await prisma.tenantIntegration.update({ where: { id: w.id }, data: { config: cfg as any } });
    }

    res.json({
      data: {
        role,
        elected: plan.elected,
        replaced: plan.replaced,
      },
    });
  } catch (err) {
    console.error("business-core role write error:", err);
    res.status(500).json({ error: "Failed to choose a system for that part" });
  }
});

/**
 * PUT /business-core/use-case - what kind of business this is.
 *
 * Decides which parts the screen asks about at all. A durable setting rather
 * than a column: it is a tenant-level choice, the store is already the one
 * `businessHours` uses, and it needs no migration.
 *
 * Deliberately NOT read from `BusinessDiscovery.business.businessModel`, which
 * is free text the website scan produced. A scan's guess is not a choice, and
 * this value decides which questions a merchant is asked.
 */
// Gated on the SAME permission as electing a source of truth, because that is
// what this is: choosing which system serves a part of the business. A new
// permission key for the same act would be a second answer to one question.
router.put("/business-core/use-case", canSelectSot, async (req: Request, res: Response) => {
  const value = (req.body ?? {}).useCase;
  if (!isUseCase(value)) {
    res.status(422).json({ error: "useCase must be one of: ecommerce, leads, both" });
    return;
  }
  try {
    // ★ THE RAW STRING, NOT JSON.stringify. `writeDurableSetting` mirrors
    // EXACTLY what it is given into the Redis cache, while the database gets
    // `JSON.parse(value)` when that succeeds. So stringifying a bare string
    // stores `leads` in Postgres and `"leads"` - with quotes - in the cache:
    // the value then reads back correctly after an eviction and WRONGLY while
    // cached, which is the worst shape a bug can have.
    //
    // Caught live: the PUT returned 200 and the GET still reported no use case.
    // `businessHours` passes JSON.stringify because it stores an OBJECT and its
    // reader parses; a scalar must not.
    await writeDurableSetting(req.tenantId!, BUSINESS_MODEL_KEY, value, (req as any).user?.userId);
    res.json({ data: { useCase: value } });
  } catch (err) {
    console.error("business-core use-case write error:", err);
    res.status(500).json({ error: "Failed to save the use case" });
  }
});

// GET /source-of-truth - the tenant's ELECTED customer system of record as
// the AI-side resolver actually sees it, with its truthful capability set.
// This is what the UI must render (never frontend guesses): which system
// answers "who is this customer", whether back-office writes are available,
// and which operations the provider genuinely supports. Registered BEFORE
// /:slug so the literal path wins.
router.get("/source-of-truth", async (req: Request, res: Response) => {
  try {
    const provider = await getSourceOfTruth(req.tenantId!);
    if (!provider) {
      res.json({ data: { configured: false, vendor: null, capabilities: [] } });
      return;
    }
    const all: SourceOfTruthCapability[] = [
      "identify_customer", "customer_context", "related_business_context",
      "write_conversation_summary", "write_interaction", "update_customer_fields",
      "create_task", "merge_contacts",
    ];
    res.json({
      data: {
        configured: true,
        vendor: provider.vendor,
        capabilities: provider.capabilities(),
        unsupported: all.filter((c) => !provider.supports(c)),
        writesEnabled: provider.supports("write_conversation_summary"),
      },
    });
  } catch (err) {
    console.error("source-of-truth status error:", err);
    res.status(500).json({ error: "Failed to resolve source of truth" });
  }
});

// GET /source-of-truth/customers?q= - unified, tenant-scoped customer search
// for outbound calling. Searches THE resolved source of truth (Shopify-as-CRM
// included), so the dialer offers the same identities that answer "who is
// this customer" everywhere else - never another tenant's data, never a
// free-text number promoted to an identity.
//
// Query detection: phone-shaped and email-shaped inputs go through the
// vendor-neutral adapter's identifier lookup; everything else is a NAME
// search - adapter-native when the adapter implements searchByName (Shopify:
// default text search + first_name/last_name filters, `read_customers`
// enforced by the tool plane), shared CRM lead/contact search otherwise.
//
// The list is a PICKER: identifiers come back MASKED. Full contact data is
// served by /source-of-truth/customers/detail only after the human selects a
// candidate - a search never auto-resolves to "the first match".
// Registered BEFORE /:slug so the literal path wins.
router.get("/source-of-truth/customers", requirePermissionOrRole("crm:contacts:read", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const q = String(req.query.q ?? "").trim();
    const limit = Math.min(parseInt(String(req.query.limit ?? "8"), 10) || 8, 20);
    const vendor = await resolveCrmVendor(tenantId);
    if (!vendor) {
      res.json({ data: [], meta: { configured: false, vendor: null } });
      return;
    }
    if (!q) {
      res.json({ data: [], meta: { configured: true, vendor } });
      return;
    }

    type Row = {
      id: string;
      kind: string;
      name: string | null;
      phoneMasked: string | null;
      emailMasked: string | null;
      company: string | null;
      stage: string | null;
      vendor: string;
      callable: boolean;
      ordersCount: number | null;
      totalSpent: string | null;
      currency: string | null;
    };
    const rows: Row[] = [];
    let searchFailed: string | null = null;

    const looksLikeEmail = /@/.test(q);
    const phoneish = q.replace(/[\s\-().]/g, "");
    const looksLikePhone = /^\+?\d{5,15}$/.test(phoneish);

    if (looksLikeEmail || looksLikePhone) {
      const adapter = await getCrmAdapter(tenantId);
      const r = await adapter.findCustomer(looksLikeEmail ? { email: q } : { phone: phoneish });
      if (!r.ok && r.reason) searchFailed = r.reason;
      for (const c of r.ok ? r.contacts : []) {
        rows.push({
          id: c.id,
          kind: c.kind,
          name: c.display_name,
          phoneMasked: maskPhone(c.phone),
          emailMasked: maskEmail(c.email),
          company: null,
          stage: c.stage,
          vendor,
          callable: !!c.phone,
          ordersCount: null,
          totalSpent: null,
          currency: null,
        });
      }
    } else {
      const adapter = await getCrmAdapter(tenantId);
      if (typeof adapter.searchByName === "function") {
        const r = await adapter.searchByName(q, limit);
        if (!r.ok && r.reason) searchFailed = r.reason;
        for (const c of r.ok ? r.candidates : []) {
          rows.push({
            id: c.id,
            kind: c.kind,
            name: c.display_name,
            phoneMasked: maskPhone(c.phone),
            emailMasked: maskEmail(c.email),
            company: null,
            stage: null,
            vendor,
            callable: !!c.phone,
            ordersCount: c.orders_count,
            totalSpent: c.total_spent,
            currency: c.currency,
          });
        }
      } else {
        // Shared vendor-native free-text search (dedicated CRMs). Best-effort.
        const [leads, contacts] = await Promise.all([
          crmSearchLeads(tenantId, { name: q }).catch(() => []),
          crmSearchContacts(tenantId, { name: q }).catch(() => []),
        ]);
        const seen = new Set<string>();
        for (const r of [...contacts, ...leads]) {
          const key = (r.email || r.phone || r.id || "").toLowerCase();
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          rows.push({
            id: r.id,
            kind: "contact",
            name: r.name ?? null,
            phoneMasked: maskPhone(r.phone ?? null),
            emailMasked: maskEmail(r.email ?? null),
            company: (r as { company?: string }).company ?? null,
            stage: null,
            vendor,
            callable: !!r.phone,
            ordersCount: null,
            totalSpent: null,
            currency: null,
          });
        }
      }
    }

    // A missing vendor scope is an actionable state, not an empty result -
    // the UI tells the admin to re-connect with customer-read access.
    const missingScope = !!searchFailed && /scope|read_customers|access/i.test(searchFailed);
    res.json({ data: rows.slice(0, limit), meta: { configured: true, vendor, missingScope } });
  } catch (err) {
    console.error("source-of-truth customer search error:", err);
    res.status(500).json({ error: "Failed to search customers" });
  }
});

// GET /source-of-truth/customers/detail?id=&kind= - full contact data for ONE
// explicitly selected candidate (the list above is masked). Same permission
// gate; the adapter resolves within the active tenant's own connection, so a
// foreign id can never cross tenants - it simply doesn't exist there.
router.get("/source-of-truth/customers/detail", requirePermissionOrRole("crm:contacts:read", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const id = String(req.query.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    const vendor = await resolveCrmVendor(tenantId);
    if (!vendor) {
      res.status(404).json({ error: "No source of truth connected" });
      return;
    }
    const adapter = await getCrmAdapter(tenantId);
    const r = await adapter.findCustomer({ external_id: id });
    const c = r.ok ? r.contacts[0] : undefined;
    if (!c) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    res.json({
      data: {
        id: c.id,
        kind: c.kind,
        name: c.display_name,
        phone: c.phone,
        email: c.email,
        stage: c.stage,
        vendor,
      },
    });
  } catch (err) {
    console.error("source-of-truth customer detail error:", err);
    res.status(500).json({ error: "Failed to load customer" });
  }
});

// GET /:slug - Get single catalog integration with connection status + tools
router.get("/:slug", async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;

    const entry = await prisma.integrationCatalog.findUnique({
      where: { slug },
      include: {
        catalogTools: { orderBy: { name: "asc" } },
        tenantConnections: {
          where: { tenantId: req.tenantId! },
          // `credentials` was selected here and spread into the response, twelve
          // lines from a sibling route that excludes it for the reason stated
          // there. Nothing read it: every consumer reads `.status`, and the
          // credential write paths take NEW values rather than the stored ones.
          // The gate on this router is the READ permission, so a member granted
          // only "view business systems" was receiving the encrypted secret for
          // every connected integration - viewing a screen and holding the
          // tenant's credentials should not be the same grant.
          select: {
            id: true,
            status: true,
            config: true,
            createdAt: true,
            updatedAt: true,
            lastTestedAt: true,
            lastTestResult: true,
            lastError: true,
          },
        },
      },
    });

    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    const tenantConnection = boundConnection(entry.tenantConnections[0]);
    const locale = await readerLocale(req);

    res.json({
      data: {
        ...entry,
        description: catalogDescription(entry.slug, entry.description, locale),
        authType: entry.authType,
        authSchema: entry.authSchema,
        catalogTools: entry.catalogTools.map((ct: any) => catalogTool(entry.slug, ct, locale)),
        tenantConnection,
        tenantConnections: undefined,
      },
    });
  } catch (err) {
    console.error("Get catalog integration error:", err);
    res.status(500).json({ error: "Failed to get integration" });
  }
});

// POST /:slug/connect - Connect tenant to integration (API_KEY/BASIC_AUTH path)
//
// OAuth providers should hit /api/connectors/:slug/oauth/init instead - this
// endpoint stores credentials directly. Credentials are ENCRYPTED before
// persistence (the adapter framework decrypts on load). Existing connections
// are updated in-place rather than rejected, so the marketplace can re-bind
// credentials without forcing a disconnect first.
router.post("/:slug/connect", canConnectSystems, async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const { credentials, config } = req.body;

    const entry = await prisma.integrationCatalog.findUnique({
      where: { slug },
      include: { catalogTools: { where: { isDefault: true } } },
    });

    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    if (!credentials || typeof credentials !== "object" || Object.keys(credentials).length === 0) {
      res.status(400).json({ error: "credentials required" });
      return;
    }

    const encrypted = encryptCredentials(credentials);
    const cfg = (config && typeof config === "object") ? config : {};

    // Upsert: if a connection already exists, update credentials in place.
    const existing = await prisma.tenantIntegration.findFirst({
      where: { tenantId: req.tenantId!, integrationId: entry.id },
      select: { id: true },
    });

    // PROOF BEFORE "CONNECTED". This route stored whatever was pasted and
    // called it connected; a wrong key surfaced only when a customer asked
    // something. An adapter that can check a credential (validate) is asked
    // first, and a refusal writes NOTHING - not even over an existing working
    // connection.
    const adapter = getAdapter(slug);
    if (adapter && typeof adapter.validate === "function") {
      const verdict = await adapter
        .validate({ ctx: { tenantId: req.tenantId!, tenantIntegrationId: existing?.id ?? "" }, credentials, config: cfg })
        .catch((err: any) => ({ ok: false, error: `The credentials could not be checked (${String(err?.message || "error").slice(0, 80)}).` }));
      if (!verdict.ok) {
        res.status(422).json({ error: "validation_failed", message: verdict.error ?? "The credentials were rejected." });
        return;
      }
    } else {
      // Form systems with no validate() get one read-only probe (2026-10-09).
      // Same contract as above: a refusal writes nothing, and the 422 keeps
      // the shape v2 maps; `code` says which kind of refusal it was.
      const probe = await probeConnectCredentials({ slug, tenantId: req.tenantId!, credentials, config: cfg });
      if (probe && !probe.ok) {
        if ("missing" in probe) {
          res.status(400).json({ error: "credentials required", missingFields: probe.missing });
          return;
        }
        res.status(422).json({ error: "validation_failed", code: probe.code, message: probe.message });
        return;
      }
    }
    let tenantIntegration: any;
    if (existing) {
      tenantIntegration = await prisma.tenantIntegration.update({
        where: { id: existing.id },
        data: {
          status: "CONNECTED" as any,
          credentials: encrypted as any,
          config: cfg as any,
          connectedAt: new Date(),
          lastError: null,
        },
      });
    } else {
      tenantIntegration = await prisma.tenantIntegration.create({
        data: {
          tenantId: req.tenantId!,
          integrationId: entry.id,
          status: "CONNECTED" as any,
          credentials: encrypted as any,
          config: cfg as any,
          connectedAt: new Date(),
          tenantTools: {
            create: entry.catalogTools.map((tool) => ({
              tenantId: req.tenantId!,
              catalogToolId: tool.id,
              isEnabled: true,
            })),
          },
        },
      });
    }

    res.status(201).json({ data: tenantIntegration });
  } catch (err) {
    console.error("Connect integration error:", err);
    res.status(500).json({ error: "Failed to connect integration" });
  }
});

// POST /:slug/test - Live connection test.
//
// Routes by adapter slug:
//   - If a registered adapter exposes a READ-only tool, we invoke its first
//     READ tool with empty args - a real network roundtrip that validates
//     credentials end-to-end.
//   - If no adapter is registered (e.g. zoho via the legacy path), we fall
//     back to validating required credential fields from authSchema.
//
// Marks the integration CONNECTED on success and ERROR (with lastError) on
// failure, so the marketplace UI reflects reality.
/**
 * Connection test. NOT a read - it WRITES `status`, `lastTestedAt`,
 * `lastTestResult` and `lastError` on every call.
 *
 * DO NOT fire this casually against a dev tenant to "check the route works".
 * On the shared dev database the single failing integration row is the only
 * evidence several things rest on: it is the Business-systems failure banner's
 * only example, the audit screen's only `succeeded: false` case, and the only
 * `lastError` longer than 200 characters - which is the sole proof that the
 * read-side truncation in this file does real work rather than restating a
 * write-side cap that already existed. One call to this endpoint overwrites
 * all three, and nothing regenerates them.
 *
 * Verify this route by reading it, or by rendering the notification template
 * it emits. Label that as what it is rather than as an end-to-end check.
 */
router.post("/:slug/test", canConnectSystems, async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;

    const entry = await prisma.integrationCatalog.findUnique({ where: { slug } });
    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    const tenantIntegration = await prisma.tenantIntegration.findFirst({
      where: { tenantId: req.tenantId!, integrationId: entry.id },
    });

    if (!tenantIntegration) {
      res.status(404).json({ error: "No connection found for this integration" });
      return;
    }

    const adapter = getAdapter(slug);
    if (adapter) {
      // Live ping: pick the first READ tool. We need credentials in CONNECTED
      // state for executeAdapterTool to load them, so flip status temporarily.
      await prisma.tenantIntegration.update({
        where: { id: tenantIntegration.id },
        data: { status: "CONNECTED" as any },
      });

      // Prefer the adapter's own probe when it has one. The read-tool fallback
      // below calls a tool with `{}`, which is meaningless for providers whose
      // reads have required arguments (google_calendar.list_events) - those
      // could never pass a test and sat permanently in ERROR.
      if (typeof adapter.validate === "function") {
        const creds = tenantIntegration.credentials
          ? (decryptCredentials(tenantIntegration.credentials as any) as Record<string, any>)
          : {};
        const verdict = await adapter
          .validate({
            ctx: { tenantId: req.tenantId!, tenantIntegrationId: tenantIntegration.id },
            credentials: creds,
            config: (tenantIntegration.config as Record<string, any>) || {},
          })
          .catch((e: any) => ({ ok: false, error: e?.message || "validation failed" }));
        // A fully-passing probe proves every required scope is granted - clear
        // the persisted missing-scope state so gated tools resurface and the
        // executeAdapterTool short-circuit lifts.
        if (verdict.ok) {
          await clearMissingScopes(tenantIntegration.id).catch((e: any) =>
            console.warn("[integrations] clearMissingScopes after validate failed:", e?.message));
        }
        const updated = await prisma.tenantIntegration.update({
          where: { id: tenantIntegration.id },
          data: {
            status: (verdict.ok ? "CONNECTED" : "ERROR") as any,
            lastTestedAt: new Date(),
            lastTestResult: verdict.ok,
            lastError: verdict.ok ? null : (verdict.error ?? "validation failed"),
          },
        });
        res.status(verdict.ok ? 200 : 400).json(verdict.ok ? { data: updated } : { error: verdict.error, data: updated });
        return;
      }

      const readTool = adapter.tools().find((t) => t.category === "READ");
      if (!readTool) {
        const updated = await prisma.tenantIntegration.update({
          where: { id: tenantIntegration.id },
          data: { lastTestedAt: new Date(), lastTestResult: true, status: "CONNECTED" as any, lastError: null },
        });
        res.json({ data: updated, note: "no_read_tool_available_for_live_ping" });
        return;
      }
      const r = await executeAdapterTool({
        tenantId: req.tenantId!,
        toolFunctionName: readTool.name,
        args: {},
      });
      if (r.ok) {
        const updated = await prisma.tenantIntegration.update({
          where: { id: tenantIntegration.id },
          data: { status: "CONNECTED" as any, lastTestedAt: new Date(), lastTestResult: true, lastError: null },
        });
        res.json({ data: updated });
        return;
      }
      // Some READ tools require args (e.g. shopify.get_order needs an order id)
      // - that's fine: an HTTP-level auth failure is what we're testing.
      //
      // WHAT `status: ERROR` MEANS, AND WHAT IT DOES NOT
      // The gate below is the ONLY path in this file that writes ERROR, and it
      // fires only when the failure looks like auth. Everything else - a
      // timeout, a 500, an unreachable host - takes the branch under it and is
      // recorded as CONNECTED, because "the request reached the provider".
      //
      // So ERROR means "the provider rejected our credentials" and NEVER
      // "the provider is down". A genuinely unreachable Shopify is stored as
      // healthy. Anything rendering this state must say credentials, and offer
      // reconnect rather than wait - which is why the notification emitted
      // below is `integration.check_failed` and not `integration.down`.
      //
      // It is also on demand: nothing probes on a schedule, so this state is
      // only ever as fresh as the last time a person pressed test.
      const reason = String(r.reason || "");
      const looksLikeAuth = /401|403|invalid_token|unauthor/i.test(reason);
      if (!looksLikeAuth) {
        // Treat as success - the request reached the provider, just needed args
        const updated = await prisma.tenantIntegration.update({
          where: { id: tenantIntegration.id },
          data: { status: "CONNECTED" as any, lastTestedAt: new Date(), lastTestResult: true, lastError: null },
        });
        res.json({ data: updated, note: `read_tool_responded:${reason.slice(0, 80)}` });
        return;
      }
      const updated = await prisma.tenantIntegration.update({
        where: { id: tenantIntegration.id },
        data: { status: "ERROR" as any, lastTestedAt: new Date(), lastTestResult: false, lastError: reason.slice(0, 200) },
      });
      // The only place in the product that learns a connection is unusable.
      // Emitted HERE rather than from a prober because no prober exists: this
      // runs when a person tests, so the event means "we checked and it was
      // rejected", never "it went down just now". tryEmit so a notification
      // failure cannot turn a successful diagnosis into a 500.
      tryEmit({
        type: "integration.check_failed",
        tenantId: req.tenantId!,
        data: { slug, displayName: entry.name ?? slug, reason: reason.slice(0, 200) },
        metadata: { userId: (req as any).user?.userId },
      });
      res.status(400).json({ error: reason, data: updated });
      return;
    }

    // Fallback: validate required credential fields from authSchema (legacy).
    const authSchema = (entry.authSchema as Record<string, unknown>) || {};
    const requiredFields: string[] = Array.isArray(authSchema.required)
      ? (authSchema.required as string[])
      : [];
    const storedCredentials = (tenantIntegration.credentials as Record<string, unknown>) || {};

    const missingFields = requiredFields.filter(
      (field) => !storedCredentials[field] || storedCredentials[field] === ""
    );

    if (missingFields.length > 0) {
      await prisma.tenantIntegration.update({
        where: { id: tenantIntegration.id },
        data: { lastTestedAt: new Date(), lastTestResult: false },
      });
      res.status(400).json({ error: "Missing required credential fields", missingFields });
      return;
    }

    const updated = await prisma.tenantIntegration.update({
      where: { id: tenantIntegration.id },
      data: { status: "CONNECTED", lastTestedAt: new Date(), lastTestResult: true },
    });
    res.json({ data: updated });
  } catch (err: any) {
    console.error("Test integration error:", err);
    // A live connection test against STORED credentials failed. Distinct from
    // a user typing the wrong key at connect time: these credentials already
    // worked once, so this is a rotation, a revocation or an expiry.
    reportOperationalFailure({
      errorCode: ERROR_CODES.integration_credentials_invalid,
      domain: "integration", service: "ai",
      provider: String(req.params.slug ?? "unknown"),
      cause: err,
      context: { stage: "live_connection_test" },
    });
    res.status(500).json({ error: err?.message || "Failed to test integration" });
  }
});

// POST /:slug/disconnect - Disconnect and delete tenant tools (cascade handles child rows)
router.post("/:slug/disconnect", canManageSystems, async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;

    const entry = await prisma.integrationCatalog.findUnique({ where: { slug } });
    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    const tenantIntegration = await prisma.tenantIntegration.findFirst({
      where: { tenantId: req.tenantId!, integrationId: entry.id },
    });

    if (!tenantIntegration) {
      res.status(404).json({ error: "No connection found for this integration" });
      return;
    }

    // Explicitly delete tenant tools (cascade on TenantIntegration deletion handles this,
    // but we delete them explicitly to be safe when only updating status)
    await prisma.tenantTool.deleteMany({
      where: { tenantId: req.tenantId!, tenantIntegrationId: tenantIntegration.id },
    });

    const updated = await prisma.tenantIntegration.update({
      where: { id: tenantIntegration.id },
      data: { status: "DISCONNECTED", credentials: {} },
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Disconnect integration error:", err);
    // Disconnect ran part-way. Tenant tools may be gone while the connection
    // row survives, or the reverse - either way the tenant is in a state no
    // screen represents, and reconnecting will not necessarily repair it.
    reportOperationalFailure({
      errorCode: ERROR_CODES.integration_disconnect_cleanup_failed,
      domain: "integration", service: "ai",
      provider: String(req.params.slug ?? "unknown"),
      cause: err,
      context: { stage: "disconnect_cleanup" },
    });
    res.status(500).json({ error: "Failed to disconnect integration" });
  }
});

// PUT /:slug/credentials - Update credentials (encrypted, in place)
router.put("/:slug/credentials", canConnectSystems, async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const { credentials, config } = req.body;

    if (!credentials || typeof credentials !== "object") {
      res.status(400).json({ error: "credentials are required" });
      return;
    }

    const entry = await prisma.integrationCatalog.findUnique({ where: { slug } });
    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    const tenantIntegration = await prisma.tenantIntegration.findFirst({
      where: { tenantId: req.tenantId!, integrationId: entry.id },
    });

    if (!tenantIntegration) {
      res.status(404).json({ error: "No connection found for this integration" });
      return;
    }

    const updated = await prisma.tenantIntegration.update({
      where: { id: tenantIntegration.id },
      data: {
        credentials: encryptCredentials(credentials) as any,
        ...(config && typeof config === "object" ? { config: config as any } : {}),
        lastError: null,
      },
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Update credentials error:", err);
    res.status(500).json({ error: "Failed to update credentials" });
  }
});

// PUT /:slug/crm-source - Opt this integration in/out as the tenant's CRM
// source of truth. Today only Shopify supports this (it's an ECOMMERCE
// integration a tenant may elect as their customer system of record). Sets
// `config.useAsCrm` and invalidates the CRM resolver cache so the next bot
// turn reads customer context from Shopify instead of any CRM-category
// integration. Toggling OFF restores the default resolution order - it never
// disturbs tenants who don't opt in.
router.put("/:slug/crm-source", canSelectSot, async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    if (slug !== "shopify") {
      res.status(400).json({ error: "crm-source toggle is only supported for Shopify today" });
      return;
    }
    const useAsCrm = req.body?.useAsCrm === true;

    const entry = await prisma.integrationCatalog.findUnique({ where: { slug } });
    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }
    const ti = await prisma.tenantIntegration.findFirst({
      where: { tenantId: req.tenantId!, integrationId: entry.id },
      select: { id: true, status: true, config: true },
    });
    if (!ti) {
      res.status(404).json({ error: "Connect Shopify first" });
      return;
    }
    if (useAsCrm && ti.status !== "CONNECTED") {
      res.status(409).json({ error: "Shopify must be CONNECTED before using it as your CRM" });
      return;
    }

    const cfg = (ti.config && typeof ti.config === "object" ? ti.config : {}) as Record<string, unknown>;
    cfg.useAsCrm = useAsCrm;
    const updated = await prisma.tenantIntegration.update({
      where: { id: ti.id },
      data: { config: cfg as any },
      select: { id: true, config: true },
    });
    invalidateCrmAdapterCache(req.tenantId!);

    // Electing a source of truth is a statement about where customer data
    // LIVES, so every read of that system must follow automatically. Without
    // this the resolver routes customer lookups at Shopify while the tool gate
    // still denies the reads (surface requires CONNECTED *and* an allowing
    // AgentToolPermission), and the employee goes blind on both known and
    // unknown callers. READ only - writes stay an explicit per-agent decision.
    const readToolsEnabled = useAsCrm ? await enableReadToolsForIntegration(req.tenantId!, ti.id, entry.id) : 0;

    res.json({ data: { id: updated.id, useAsCrm, config: updated.config, readToolsEnabled } });
  } catch (err) {
    console.error("crm-source toggle error:", err);
    res.status(500).json({ error: "Failed to update CRM source" });
  }
});

// GET /:slug/tools?aiAgentId=… - List catalog tools with tenant activation
// status, plus (when ?aiAgentId is passed) the per-agent permission state.
// Used by the IntegrationDrawer in two contexts:
//   - marketplace page (no aiAgentId) → toggles reflect TenantTool.isEnabled
//   - agent edit page (aiAgentId set) → toggles reflect
//     AgentToolPermission.isAllowed for that agent.
router.get("/:slug/tools", async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const aiAgentId = (req.query.aiAgentId as string | undefined) || undefined;

    const entry = await prisma.integrationCatalog.findUnique({ where: { slug } });
    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    const tenantIntegration = await prisma.tenantIntegration.findFirst({
      where: { tenantId: req.tenantId!, integrationId: entry.id },
    });

    const catalogTools = await prisma.catalogTool.findMany({
      where: { integrationId: entry.id },
      include: tenantIntegration
        ? {
            tenantTools: {
              where: { tenantId: req.tenantId!, tenantIntegrationId: tenantIntegration.id },
              select: { id: true, isEnabled: true },
            },
          }
        : undefined,
      orderBy: { name: "asc" },
    });

    // Agent-mode: index agent permissions by tenantToolId so the response
    // can carry per-agent state alongside tenant state.
    let agentPermByTenantTool = new Map<string, { id: string; isAllowed: boolean }>();
    if (aiAgentId) {
      const agent = await prisma.aIAgent.findFirst({
        where: { id: aiAgentId, tenantId: req.tenantId! },
        select: { id: true },
      });
      if (agent) {
        const perms = await prisma.agentToolPermission.findMany({
          where: { tenantId: req.tenantId!, aiAgentId },
          select: { id: true, tenantToolId: true, isAllowed: true },
        });
        for (const p of perms) {
          agentPermByTenantTool.set(p.tenantToolId, { id: p.id, isAllowed: p.isAllowed });
        }
      }
    }

    const data = catalogTools.map((tool) => {
      const tenantTool = (tool as any).tenantTools?.[0] || null;
      const agentPermission = aiAgentId && tenantTool
        ? agentPermByTenantTool.get(tenantTool.id) || null
        : null;
      return {
        ...tool,
        tenantTool,
        agentPermission,
        tenantTools: undefined,
      };
    });

    res.json({ data });
  } catch (err) {
    console.error("List integration tools error:", err);
    res.status(500).json({ error: "Failed to list tools" });
  }
});

// PUT /:slug/tools/:toolSlug - Toggle tool enabled/disabled for tenant
router.put("/:slug/tools/:toolSlug", canManageSystems, async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const toolSlug = req.params.toolSlug as string;
    const { isEnabled } = req.body;

    if (typeof isEnabled !== "boolean") {
      res.status(400).json({ error: "isEnabled (boolean) is required" });
      return;
    }

    const entry = await prisma.integrationCatalog.findUnique({ where: { slug } });
    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    const tenantIntegration = await prisma.tenantIntegration.findFirst({
      where: { tenantId: req.tenantId!, integrationId: entry.id },
    });

    if (!tenantIntegration) {
      res.status(404).json({ error: "No connection found for this integration" });
      return;
    }

    const catalogTool = await prisma.catalogTool.findFirst({
      where: { integrationId: entry.id, slug: toolSlug },
    });

    if (!catalogTool) {
      res.status(404).json({ error: "Tool not found" });
      return;
    }

    // TenantGuard requires `where.tenantId` on every mutation. The unique
    // index `tenantIntegrationId_catalogToolId` has no tenantId column, so
    // Prisma's upsert path can't carry one in `where`. Resolve manually:
    // tenant-scoped findFirst, then branch to update-by-id or create.
    const existing = await prisma.tenantTool.findFirst({
      where: {
        tenantId: req.tenantId!,
        tenantIntegrationId: tenantIntegration.id,
        catalogToolId: catalogTool.id,
      },
      select: { id: true },
    });
    const tenantTool = existing
      ? await prisma.tenantTool.update({
          where: { id: existing.id },
          data: { isEnabled },
        })
      : await prisma.tenantTool.create({
          data: {
            tenantId: req.tenantId!,
            tenantIntegrationId: tenantIntegration.id,
            catalogToolId: catalogTool.id,
            isEnabled,
          },
        });

    res.json({ data: tenantTool });
  } catch (err) {
    console.error("Toggle tool error:", err);
    res.status(500).json({ error: "Failed to update tool" });
  }
});

// ─── Monday: audience board picker ─────────────────────────────
//
// Monday's "schema" lives on a board (columns), not on a global Lead/Contact
// object. The audience builder needs the operator to pick which board acts
// as Leads and which acts as Contacts; without these, the schema fetcher
// has nothing to describe and CRM-side filter rules can't run.

// GET /:slug/monday-boards - list the operator's boards for the picker UI.
router.get("/:slug/monday-boards", async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    if (slug !== "monday") {
      res.status(404).json({ error: "monday-boards is monday-only" });
      return;
    }
    const r = await executeAdapterTool({
      tenantId: req.tenantId!,
      toolFunctionName: "monday.list_boards",
      args: { limit: 200 },
    });
    if (!r.ok) {
      res.status(502).json({ error: r.reason || "failed_to_list_boards" });
      return;
    }
    res.json({ data: r.result });
  } catch (err: any) {
    console.error("monday-boards error:", err);
    res.status(500).json({ error: "Failed to list Monday boards" });
  }
});

// PUT /:slug/audience-config - persist leadsBoardId / contactsBoardId.
//
// For Monday tenants, this maps the abstract "Leads"/"Contacts" modules
// the audience builder uses onto concrete boards. The shared CRM client
// reads these from `tenant_integrations.config` when it dispatches
// describe/search calls.
router.put("/:slug/audience-config", canManageSystems, async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const { leadsBoardId, contactsBoardId } = req.body || {};
    if (slug !== "monday") {
      res.status(400).json({ error: "audience-config currently only applies to Monday" });
      return;
    }
    const entry = await prisma.integrationCatalog.findUnique({ where: { slug } });
    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }
    const ti = await prisma.tenantIntegration.findFirst({
      where: { tenantId: req.tenantId!, integrationId: entry.id },
      select: { id: true, config: true },
    });
    if (!ti) {
      res.status(404).json({ error: "No connection found for this integration" });
      return;
    }
    const cfg = (ti.config && typeof ti.config === "object" ? ti.config : {}) as Record<string, unknown>;
    if (typeof leadsBoardId === "string" && leadsBoardId) cfg.leadsBoardId = leadsBoardId;
    if (typeof contactsBoardId === "string" && contactsBoardId) cfg.contactsBoardId = contactsBoardId;
    const updated = await prisma.tenantIntegration.update({
      where: { id: ti.id },
      data: { config: cfg as any },
      select: { id: true, config: true },
    });
    res.json({ data: updated });
  } catch (err: any) {
    console.error("audience-config error:", err);
    res.status(500).json({ error: "Failed to update audience config" });
  }
});

export default router;
