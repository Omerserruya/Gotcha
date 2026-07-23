import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireOnboardingOrActiveTenant, requireRole, requirePermissionOrRole, encryptCredentials, decryptCredentials, searchLeads as crmSearchLeads, searchContacts as crmSearchContacts } from "@chatcenter/shared";
import { executeAdapterTool, getAdapter, clearMissingScopes } from "../services/connectors/integration-framework";
import { invalidateCrmAdapterCache, getCrmAdapter, resolveCrmVendor } from "../services/connectors/crm-adapter-resolver";
import { maskPhone, maskEmail } from "../lib/mask";
import { getSourceOfTruth, type SourceOfTruthCapability } from "../services/connectors/source-of-truth";

const router = Router();

// PENDING_ONBOARDING tenants may browse and connect the marketplace too - the
// setup wizard's integrations movement matches detected tools against this
// catalog and offers real connects. requireActiveTenant() 403'd during
// onboarding, which made EVERY detected tool (ReturnGO included) render as
// "not supported yet" because the catalog fetch came back empty.
router.use(authenticate, resolveTenant, requireOnboardingOrActiveTenant(), requireRole("ADMIN"));

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
          select: { id: true, status: true, createdAt: true, config: true },
        },
      },
      orderBy: { sortOrder: "asc" },
    });

    const data = catalog.map((entry) => ({
      ...entry,
      catalogTools: entry.catalogTools.map((ct: any) => ({
        ...ct,
        tenantTool: ct.tenantTools?.[0] || null,
        tenantTools: undefined,
      })),
      authType: entry.authType,
      authSchema: entry.authSchema,
      tenantConnection: entry.tenantConnections[0] || null,
      tenantConnections: undefined,
    }));

    res.json({ data });
  } catch (err) {
    console.error("List catalog integrations error:", err);
    res.status(500).json({ error: "Failed to list integrations" });
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
          select: { id: true, status: true, credentials: true, config: true, createdAt: true, updatedAt: true },
        },
      },
    });

    if (!entry) {
      res.status(404).json({ error: "Integration not found" });
      return;
    }

    const tenantConnection = entry.tenantConnections[0] || null;

    res.json({
      data: {
        ...entry,
        authType: entry.authType,
        authSchema: entry.authSchema,
        catalogTools: entry.catalogTools,
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
router.post("/:slug/connect", async (req: Request, res: Response) => {
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
router.post("/:slug/test", async (req: Request, res: Response) => {
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
    res.status(500).json({ error: err?.message || "Failed to test integration" });
  }
});

// POST /:slug/disconnect - Disconnect and delete tenant tools (cascade handles child rows)
router.post("/:slug/disconnect", async (req: Request, res: Response) => {
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
    res.status(500).json({ error: "Failed to disconnect integration" });
  }
});

// PUT /:slug/credentials - Update credentials (encrypted, in place)
router.put("/:slug/credentials", async (req: Request, res: Response) => {
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

/**
 * Grant every READ tool of an integration to every AI employee of the tenant.
 *
 * Used when an integration is elected the CRM source of truth: reading the
 * system of record is implied by that choice, so the tenant should not have to
 * tick 40 boxes by hand for the employee to see its own customers.
 *
 * Idempotent, and never downgrades: rows the operator has explicitly turned
 * OFF are left alone rather than silently re-enabled on every toggle.
 * Returns the number of permissions newly granted.
 */
async function enableReadToolsForIntegration(
  tenantId: string,
  tenantIntegrationId: string,
  catalogIntegrationId: string,
): Promise<number> {
  const readTools = await prisma.catalogTool.findMany({
    where: { integrationId: catalogIntegrationId, category: "READ" },
    select: { id: true },
  });
  if (readTools.length === 0) return 0;

  // A TenantTool row must exist before it can be permissioned. Upsert is not
  // available here: the shared TenantGuard rejects any where clause without
  // tenantId, and the compound unique key (tenantIntegrationId, catalogToolId)
  // cannot carry one. So read what exists, then create only the gaps.
  const readToolIds = readTools.map((t) => t.id);
  const existingTools = await prisma.tenantTool.findMany({
    where: { tenantId, tenantIntegrationId, catalogToolId: { in: readToolIds } },
    select: { catalogToolId: true },
  });
  const haveTool = new Set(existingTools.map((t) => t.catalogToolId));
  const missingTools = readToolIds.filter((id) => !haveTool.has(id));
  if (missingTools.length > 0) {
    await prisma.tenantTool.createMany({
      data: missingTools.map((catalogToolId) => ({ tenantId, tenantIntegrationId, catalogToolId, isEnabled: true })),
      skipDuplicates: true,
    });
  }

  const [tenantTools, aiAgents] = await Promise.all([
    prisma.tenantTool.findMany({
      where: { tenantId, tenantIntegrationId, catalogToolId: { in: readToolIds } },
      select: { id: true },
    }),
    prisma.aIAgent.findMany({ where: { tenantId }, select: { id: true } }),
  ]);
  if (aiAgents.length === 0) return 0;

  // The unique index is [tenantToolId, departmentId, agentId] - it does NOT
  // cover aiAgentId, so an upsert keyed on the AI agent is not expressible.
  // Read what exists, then create only the gaps.
  const existing = await prisma.agentToolPermission.findMany({
    where: { tenantId, aiAgentId: { in: aiAgents.map((a) => a.id) }, tenantToolId: { in: tenantTools.map((t) => t.id) } },
    select: { aiAgentId: true, tenantToolId: true },
  });
  const seen = new Set(existing.map((p) => `${p.aiAgentId}:${p.tenantToolId}`));

  const toCreate = aiAgents.flatMap((agent) =>
    tenantTools
      .filter((tt) => !seen.has(`${agent.id}:${tt.id}`))
      .map((tt) => ({ tenantId, aiAgentId: agent.id, tenantToolId: tt.id, isAllowed: true })),
  );
  if (toCreate.length === 0) return 0;

  const { count } = await prisma.agentToolPermission.createMany({ data: toCreate, skipDuplicates: true });
  console.log("[integrations] source-of-truth read tools granted", JSON.stringify({
    tenantId, tenantIntegrationId, readTools: readTools.length, aiAgents: aiAgents.length, granted: count,
  }));
  return count;
}

// PUT /:slug/crm-source - Opt this integration in/out as the tenant's CRM
// source of truth. Today only Shopify supports this (it's an ECOMMERCE
// integration a tenant may elect as their customer system of record). Sets
// `config.useAsCrm` and invalidates the CRM resolver cache so the next bot
// turn reads customer context from Shopify instead of any CRM-category
// integration. Toggling OFF restores the default resolution order - it never
// disturbs tenants who don't opt in.
router.put("/:slug/crm-source", async (req: Request, res: Response) => {
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
router.put("/:slug/tools/:toolSlug", async (req: Request, res: Response) => {
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
router.put("/:slug/audience-config", async (req: Request, res: Response) => {
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
