import { describe, it, expect } from "vitest";
import {
  classifyCatalogIntegration,
  classifyChannel,
  classifyKnowledgeSource,
  gotchaEntry,
  buildWorkspaceSidebar,
  governableToolCount,
  GOTCHA_ENTRY_ID,
  type CatalogIntegrationInput,
} from "../integration-workspace";

const catalog = (over: Partial<CatalogIntegrationInput> = {}): CatalogIntegrationInput => ({
  slug: "shopify", name: "Shopify", category: "ECOMMERCE",
  description: "Orders, customers, refunds", toolCount: 62,
  connection: { status: "CONNECTED" },
  ...over,
});

describe("a provider earns a full entry only when it has tools to govern", () => {
  it("treats a provider WITH executable tools as a tool integration", () => {
    const e = classifyCatalogIntegration(catalog());
    expect(e.kind).toBe("tool_integration");
    expect(e.toolCount).toBe(62);
    expect(e.owner).toBeUndefined();
  });

  it("treats a provider with NO tools as an external connection, not an empty tool surface", () => {
    // custom_api before any tool is defined: there is no policy to show, so
    // presenting it as a tool integration would be a screen full of nothing.
    const e = classifyCatalogIntegration(catalog({ slug: "custom_api", name: "Custom API", toolCount: 0 }));
    expect(e.kind).toBe("external_connection");
    expect(e.owner).toBe("integration_setup");
    expect(e.href).toBe("/settings/business-systems/custom_api");
  });

  it("NEVER reports a tool count of 0 - it reports no count at all", () => {
    // "WhatsApp - 0 tools" invites the reader to conclude tools are missing or
    // broken. The truth is that tool counts do not apply.
    for (const e of [
      classifyCatalogIntegration(catalog({ toolCount: 0 })),
      classifyChannel({ channel: "WHATSAPP", connectionStatus: "CONNECTED" }),
      classifyKnowledgeSource({ provider: "google_drive", isActive: true }),
    ]) {
      expect(e.toolCount, e.name).toBeNull();
      expect(e.toolCount, e.name).not.toBe(0);
    }
  });

  it("classification follows the catalog, so gaining a first tool promotes a provider", () => {
    expect(classifyCatalogIntegration(catalog({ slug: "google_calendar", toolCount: 0 })).kind)
      .toBe("external_connection");
    expect(classifyCatalogIntegration(catalog({ slug: "google_calendar", toolCount: 1 })).kind)
      .toBe("tool_integration");
  });
});

describe("channels stay channels", () => {
  it("is always an external connection owned by Channels, even when connected", () => {
    const e = classifyChannel({ channel: "WHATSAPP", connectionStatus: "CONNECTED" });
    expect(e.kind).toBe("external_connection");
    expect(e.owner).toBe("channels");
    expect(e.href).toBe("/settings/channels");
    expect(e.state).toBe("connected");
  });

  it("surfaces a channel in ERROR as a warning rather than hiding it", () => {
    const e = classifyChannel({ channel: "INSTAGRAM", connectionStatus: "ERROR" });
    expect(e.state).toBe("warning");
    expect(e.warning?.reason).toBe("capability_error");
  });

  it("gives channels human names", () => {
    expect(classifyChannel({ channel: "SHOPIFY_LIVE_CHAT", connectionStatus: "CONNECTED" }).name)
      .toBe("Shopify live chat");
    // An unknown channel type falls back to its raw value rather than throwing.
    expect(classifyChannel({ channel: "TELEPATHY", connectionStatus: "CONNECTED" }).name).toBe("TELEPATHY");
  });
});

describe("knowledge sources stay with Knowledge Manager", () => {
  it("points at the Knowledge screen, not at a tool surface", () => {
    const e = classifyKnowledgeSource({ provider: "google_drive", isActive: true });
    expect(e.kind).toBe("external_connection");
    expect(e.owner).toBe("knowledge");
    expect(e.href).toBe("/ai-studio/knowledge");
    expect(e.name).toBe("Google Drive");
  });
});

describe("connection state", () => {
  it("an unconnected integration that HAS tools is available, never status-only", () => {
    // toolCount must be "tools this integration has", not "tools this tenant
    // can set policy on right now". Feeding it a connected-only count made
    // every unconnected integration classify as an external connection, so the
    // Available group could never contain anything and the reason to connect
    // an integration was invisible.
    const e = classifyCatalogIntegration(catalog({ connection: undefined, toolCount: 10 }));
    expect(e.kind).toBe("tool_integration");
    expect(e.state).toBe("available");
    expect(e.toolCount).toBe(10);

    const sidebar = buildWorkspaceSidebar([e]);
    expect(sidebar.toolIntegrations.available).toHaveLength(1);
    expect(sidebar.externalConnections).toHaveLength(0);
  });

  it("distinguishes available, disconnected, warning and plan-blocked", () => {
    expect(classifyCatalogIntegration(catalog({ connection: undefined })).state).toBe("available");
    expect(classifyCatalogIntegration(catalog({ connection: { status: "PENDING" } })).state).toBe("disconnected");
    expect(classifyCatalogIntegration(catalog({ entitled: false })).state).toBe("not_entitled");
    expect(classifyCatalogIntegration(catalog({
      connection: { status: "CONNECTED", missingScopes: ["write_orders"] },
    })).state).toBe("warning");
  });

  it("a plan block outranks everything, because nothing else is actionable first", () => {
    const e = classifyCatalogIntegration(catalog({ entitled: false, connection: { status: "PENDING" } }));
    expect(e.state).toBe("not_entitled");
  });

  it("names the missing scopes on a degraded connection", () => {
    const e = classifyCatalogIntegration(catalog({
      connection: { status: "CONNECTED", missingScopes: ["write_orders", "read_returns"] },
    }));
    expect(e.warning).toEqual({ reason: "missing_scopes", scopes: ["write_orders", "read_returns"] });
  });

  it("treats a stale or failed capability probe as degraded, not as healthy", () => {
    expect(classifyCatalogIntegration(catalog({
      connection: { status: "CONNECTED", capabilityStatus: "error" },
    })).warning?.reason).toBe("capability_error");
    expect(classifyCatalogIntegration(catalog({
      connection: { status: "CONNECTED", capabilityFresh: false },
    })).warning?.reason).toBe("stale");
  });

  it("a healthy connection carries no warning", () => {
    const e = classifyCatalogIntegration(catalog({
      connection: { status: "CONNECTED", capabilityStatus: "ok", capabilityFresh: true },
    }));
    expect(e.state).toBe("connected");
    expect(e.warning).toBeUndefined();
  });
});

describe("GOTCHA", () => {
  it("is a full, always-connected internal integration", () => {
    const e = gotchaEntry({ toolCount: 23 });
    expect(e.id).toBe(GOTCHA_ENTRY_ID);
    expect(e.kind).toBe("tool_integration");
    expect(e.state).toBe("connected");
    expect(e.internal).toBe(true);
    expect(e.toolCount).toBe(23);
  });
});

describe("sidebar assembly", () => {
  const entries = [
    classifyCatalogIntegration(catalog()),                                                    // Shopify, connected
    classifyCatalogIntegration(catalog({ slug: "hubspot", name: "HubSpot", toolCount: 10, connection: undefined })),
    classifyCatalogIntegration(catalog({ slug: "zoho_crm", name: "Zoho CRM", toolCount: 22, connection: { status: "PENDING" } })),
    classifyCatalogIntegration(catalog({ slug: "stripe", name: "Stripe", toolCount: 5, entitled: false })),
    classifyCatalogIntegration(catalog({ slug: "custom_api", name: "Custom API", toolCount: 0 })),
    classifyChannel({ channel: "WHATSAPP", connectionStatus: "CONNECTED" }),
    classifyKnowledgeSource({ provider: "google_drive", isActive: true }),
    gotchaEntry({ toolCount: 23 }),
  ];
  const sidebar = buildWorkspaceSidebar(entries);

  it("keeps tool integrations and external connections in separate lists", () => {
    const toolNames = [
      ...sidebar.toolIntegrations.connected,
      ...sidebar.toolIntegrations.available,
      ...sidebar.toolIntegrations.unavailable,
    ].map((e) => e.name);
    expect(toolNames).toEqual(expect.arrayContaining(["GOTCHA", "Shopify", "HubSpot", "Zoho CRM", "Stripe"]));
    // A channel must never appear among tool integrations.
    expect(toolNames).not.toContain("WhatsApp");
    expect(toolNames).not.toContain("Google Drive");
    expect(toolNames).not.toContain("Custom API");
  });

  it("lists channels and knowledge sources as external connections", () => {
    expect(sidebar.externalConnections.map((e) => e.name).sort())
      .toEqual(["Custom API", "Google Drive", "WhatsApp"]);
  });

  it("pins GOTCHA first among connected", () => {
    expect(sidebar.toolIntegrations.connected[0]!.id).toBe(GOTCHA_ENTRY_ID);
  });

  it("groups available separately from unusable, most actionable first", () => {
    expect(sidebar.toolIntegrations.available.map((e) => e.name)).toEqual(["HubSpot"]);
    // Zoho (disconnected) before Stripe (plan-blocked): reconnecting is
    // something the admin can do right now, upgrading a plan is not.
    expect(sidebar.toolIntegrations.unavailable.map((e) => e.name)).toEqual(["Zoho CRM", "Stripe"]);
  });

  it("counts only what can actually be governed here", () => {
    // Shopify 62 + GOTCHA 23 + HubSpot 10 + Zoho 22 + Stripe 5. Channels,
    // Drive and the tool-less provider contribute nothing.
    expect(governableToolCount(entries)).toBe(122);
  });

  it("is stable and total - every entry lands in exactly one group", () => {
    const all = [
      ...sidebar.toolIntegrations.connected,
      ...sidebar.toolIntegrations.available,
      ...sidebar.toolIntegrations.unavailable,
      ...sidebar.externalConnections,
    ];
    expect(all).toHaveLength(entries.length);
    expect(new Set(all.map((e) => e.id)).size).toBe(entries.length);
  });

  it("handles an empty tenant", () => {
    const empty = buildWorkspaceSidebar([]);
    expect(empty.toolIntegrations.connected).toEqual([]);
    expect(empty.externalConnections).toEqual([]);
    expect(governableToolCount([])).toBe(0);
  });
});
