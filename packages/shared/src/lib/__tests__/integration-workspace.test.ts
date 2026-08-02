import { describe, it, expect } from "vitest";
import {
  classifyCatalogIntegration,
  classifyKnowledgeSource,
  gotchaEntry,
  buildWorkspaceSidebar,
  governableToolCount,
  channelDependencyFor,
  CHANNEL_DELIVERY_TOOLS,
  GOTCHA_ENTRY_ID,
  type CatalogIntegrationInput,
  type WorkspaceEntry,
} from "../integration-workspace";

const catalog = (over: Partial<CatalogIntegrationInput> = {}): CatalogIntegrationInput => ({
  slug: "shopify", name: "Shopify", category: "ECOMMERCE",
  description: "Orders, customers, refunds", toolCount: 62,
  connection: { status: "CONNECTED" },
  ...over,
});

/** Asserts the row is listed, and narrows away the null. */
const listed = (input: CatalogIntegrationInput): WorkspaceEntry => {
  const e = classifyCatalogIntegration(input);
  expect(e, `${input.slug} should be listed`).not.toBeNull();
  return e!;
};

describe("a provider earns a full entry only when it has tools to govern", () => {
  it("treats a provider WITH executable tools as a tool integration", () => {
    const e = listed(catalog());
    expect(e.kind).toBe("tool_integration");
    expect(e.toolCount).toBe(62);
    expect(e.owner).toBeUndefined();
  });

  it("treats a CONNECTED provider with no tools as an external connection", () => {
    // Nothing to govern, but the tenant does hold a connection, so the honest
    // thing is a status row pointing at the page that owns it - not a tool
    // surface with nothing on it.
    const e = listed(catalog({ slug: "custom_api", name: "Custom API", toolCount: 0 }));
    expect(e.kind).toBe("external_connection");
    expect(e.owner).toBe("integration_setup");
    expect(e.href).toBe("/settings/business-systems/custom_api");
  });

  it("NEVER reports a tool count of 0 - it reports no count at all", () => {
    // "Google Drive - 0 tools" invites the reader to conclude tools are missing
    // or broken. The truth is that tool counts do not apply.
    for (const e of [
      listed(catalog({ toolCount: 0 })),
      classifyKnowledgeSource({ provider: "google_drive", isActive: true }),
    ]) {
      expect(e.toolCount, e.name).toBeNull();
      expect(e.toolCount, e.name).not.toBe(0);
    }
  });

  it("classification follows the catalog, so gaining a first tool promotes a provider", () => {
    expect(listed(catalog({ slug: "google_calendar", toolCount: 0 })).kind)
      .toBe("external_connection");
    expect(listed(catalog({ slug: "google_calendar", toolCount: 1 })).kind)
      .toBe("tool_integration");
  });
});

describe("rows that do not belong on this screen are not shown at all", () => {
  it("drops a provider with nothing to govern that the tenant never connected", () => {
    // custom_api before any tool is defined AND before it is connected. It sat
    // under a heading reading "connected services" while being connected to
    // nothing - there was no true sentence this screen could say about it.
    expect(classifyCatalogIntegration(
      catalog({ slug: "custom_api", name: "Custom API", toolCount: 0, connection: undefined }),
    )).toBeNull();
  });

  it("drops an UNPUBLISHED provider the tenant never connected", () => {
    // The catalog withdraws a provider by unpublishing it (calendly, whose
    // connector is incomplete), and the detail route 404s on exactly those - so
    // listing one produced a row that could not be opened.
    expect(classifyCatalogIntegration(
      catalog({ slug: "calendly", name: "Calendly", toolCount: 3, isPublished: false, connection: undefined }),
    )).toBeNull();
  });

  it("NEVER hides a connection the tenant actually holds, whatever the catalog says", () => {
    // Unpublishing is about advertising. A tenant who connected a provider
    // before it was withdrawn still has a live connection, and hiding it is the
    // worse lie.
    const e = listed(catalog({
      slug: "calendly", name: "Calendly", toolCount: 0, isPublished: false,
      connection: { status: "CONNECTED" },
    }));
    expect(e.kind).toBe("external_connection");
    expect(e.state).toBe("connected");
  });

  it("keeps a published, unconnected provider that HAS tools - that is the reason to connect it", () => {
    expect(classifyCatalogIntegration(catalog({ connection: undefined, isPublished: true }))).not.toBeNull();
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
    const e = listed(catalog({ connection: undefined, toolCount: 10 }));
    expect(e.kind).toBe("tool_integration");
    expect(e.state).toBe("available");
    expect(e.toolCount).toBe(10);

    const sidebar = buildWorkspaceSidebar([e]);
    expect(sidebar.toolIntegrations.available).toHaveLength(1);
    expect(sidebar.externalConnections).toHaveLength(0);
  });

  it("distinguishes available, disconnected, warning and plan-blocked", () => {
    expect(listed(catalog({ connection: undefined })).state).toBe("available");
    expect(listed(catalog({ connection: { status: "PENDING" } })).state).toBe("disconnected");
    expect(listed(catalog({ entitled: false })).state).toBe("not_entitled");
    expect(listed(catalog({
      connection: { status: "CONNECTED", missingScopes: ["write_orders"] },
    })).state).toBe("warning");
  });

  it("a plan block outranks everything, because nothing else is actionable first", () => {
    const e = listed(catalog({ entitled: false, connection: { status: "PENDING" } }));
    expect(e.state).toBe("not_entitled");
  });

  it("names the missing scopes on a degraded connection", () => {
    const e = listed(catalog({
      connection: { status: "CONNECTED", missingScopes: ["write_orders", "read_returns"] },
    }));
    expect(e.warning).toEqual({ reason: "missing_scopes", scopes: ["write_orders", "read_returns"] });
  });

  it("treats a stale or failed capability probe as degraded, not as healthy", () => {
    expect(listed(catalog({
      connection: { status: "CONNECTED", capabilityStatus: "error" },
    })).warning?.reason).toBe("capability_error");
    expect(listed(catalog({
      connection: { status: "CONNECTED", capabilityFresh: false },
    })).warning?.reason).toBe("stale");
  });

  it("a healthy connection carries no warning", () => {
    const e = listed(catalog({
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
    listed(catalog()),                                                    // Shopify, connected
    listed(catalog({ slug: "hubspot", name: "HubSpot", toolCount: 10, connection: undefined })),
    listed(catalog({ slug: "zoho_crm", name: "Zoho CRM", toolCount: 22, connection: { status: "PENDING" } })),
    listed(catalog({ slug: "stripe", name: "Stripe", toolCount: 5, entitled: false })),
    listed(catalog({ slug: "custom_api", name: "Custom API", toolCount: 0 })),
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
    expect(toolNames).not.toContain("Google Drive");
    expect(toolNames).not.toContain("Custom API");
  });

  it("lists knowledge sources and tool-less connections as external connections", () => {
    expect(sidebar.externalConnections.map((e) => e.name).sort())
      .toEqual(["Custom API", "Google Drive"]);
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
    // Shopify 62 + GOTCHA 23 + HubSpot 10 + Zoho 22 + Stripe 5. Drive and the
    // tool-less provider contribute nothing.
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

describe("channels are a dependency note, not a sidebar row", () => {
  const DELIVERY = ["send_message", "create_broadcast", "get_contact", "close_conversation"];

  it("says nothing when a channel can deliver - a note that always shows is a note nobody reads", () => {
    expect(channelDependencyFor({
      toolNames: DELIVERY,
      channels: [{ channel: "WHATSAPP", connectionStatus: "CONNECTED" }],
    })).toBeNull();
  });

  it("says nothing on a surface with no delivery tools, however broken the channels are", () => {
    // Shopify's tools do not send anything to a customer over a channel, so a
    // dead WhatsApp is not this surface's problem to report.
    expect(channelDependencyFor({
      toolNames: ["get_order", "refund_order"],
      channels: [{ channel: "WHATSAPP", connectionStatus: "ERROR" }],
    })).toBeNull();
  });

  it("reports a degraded channel alongside the healthy ones", () => {
    const dep = channelDependencyFor({
      toolNames: DELIVERY,
      channels: [
        { channel: "WHATSAPP", connectionStatus: "CONNECTED" },
        { channel: "INSTAGRAM", connectionStatus: "ERROR" },
      ],
    });
    expect(dep).toEqual({
      connected: ["WhatsApp"],
      degraded: ["Instagram"],
      toolCount: 2,
      href: "/settings/channels",
    });
  });

  it("reports the case that matters most: nothing can deliver at all", () => {
    const dep = channelDependencyFor({ toolNames: DELIVERY, channels: [] });
    expect(dep?.connected).toEqual([]);
    expect(dep?.toolCount).toBe(2);
  });

  it("does not treat a channel the tenant switched off as a problem", () => {
    // DISCONNECTED is a choice, not a fault. Only a channel meant to work and
    // failing earns a warning.
    const dep = channelDependencyFor({
      toolNames: DELIVERY,
      channels: [{ channel: "SLACK", connectionStatus: "DISCONNECTED" }],
    });
    expect(dep?.degraded).toEqual([]);
    expect(dep?.connected).toEqual([]);
  });

  it("counts only tools that actually put a message on a channel", () => {
    // preview_broadcast renders without sending; escalate_to_human hands off
    // inside a conversation that already exists. Neither needs a channel grant.
    expect(CHANNEL_DELIVERY_TOOLS.has("preview_broadcast")).toBe(false);
    expect(CHANNEL_DELIVERY_TOOLS.has("escalate_to_human")).toBe(false);
    expect(CHANNEL_DELIVERY_TOOLS.has("send_message")).toBe(true);
  });

  it("gives channels human names and survives one it has never heard of", () => {
    const dep = channelDependencyFor({
      toolNames: DELIVERY,
      channels: [
        { channel: "SHOPIFY_LIVE_CHAT", connectionStatus: "ERROR" },
        { channel: "TELEPATHY", connectionStatus: "ERROR" },
      ],
    });
    expect(dep?.degraded).toEqual(["Shopify live chat", "TELEPATHY"]);
  });

  it("counts a channel once, however many accounts the tenant has on it", () => {
    const dep = channelDependencyFor({
      toolNames: DELIVERY,
      channels: [
        { channel: "WHATSAPP", connectionStatus: "ERROR" },
        { channel: "WHATSAPP", connectionStatus: "ERROR" },
      ],
    });
    expect(dep?.degraded).toEqual(["WhatsApp"]);
  });
});
