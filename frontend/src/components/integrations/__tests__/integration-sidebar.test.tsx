import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IntegrationSidebar } from "../IntegrationSidebar";
import type { WorkspaceEntry, WorkspaceSidebar } from "@/lib/api-integration-workspace";

const tool = (over: Partial<WorkspaceEntry>): WorkspaceEntry => ({
  id: "shopify", name: "Shopify", kind: "tool_integration", state: "connected",
  category: "ECOMMERCE", description: null, logoUrl: null, toolCount: 62, ...over,
});
const external = (over: Partial<WorkspaceEntry>): WorkspaceEntry => ({
  id: "channel:WHATSAPP", name: "WhatsApp", kind: "external_connection", state: "connected",
  category: "Channel", description: null, logoUrl: null, toolCount: null,
  owner: "channels", href: "/settings/channels", ...over,
});

const sidebar: WorkspaceSidebar = {
  toolIntegrations: {
    connected: [tool({ id: "gotcha", name: "GOTCHA", toolCount: 23, internal: true }), tool({})],
    available: [tool({ id: "hubspot", name: "HubSpot", toolCount: 10, state: "available" })],
    unavailable: [tool({ id: "stripe", name: "Stripe", toolCount: 5, state: "not_entitled" })],
  },
  externalConnections: [
    external({}),
    external({ id: "knowledge:google_drive", name: "Google Drive", owner: "knowledge", href: "/ai-studio/knowledge", category: "Knowledge source" }),
  ],
};

const base = { selectedId: "gotcha", onSelect: () => {}, he: false, search: "", onSearch: () => {} };

describe("sidebar grouping matches the reference", () => {
  it("puts every connected tool integration under one Connected heading", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByTestId("sidebar-integration-gotcha")).toBeTruthy();
    expect(screen.getByTestId("sidebar-integration-shopify")).toBeTruthy();
  });

  it("shows ONE divider, then one Available group holding everything not connected", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    expect(screen.getByTestId("sidebar-divider")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
    // "Not usable now" was a second place to look for the same thing.
    expect(screen.queryByText("Not usable now")).toBeNull();
    expect(screen.getByTestId("sidebar-integration-hubspot")).toBeTruthy();
    expect(screen.getByTestId("sidebar-integration-stripe")).toBeTruthy();
  });

  it("carries a plan condition ON the row instead of in a separate group", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    expect(screen.getByTestId("sidebar-integration-stripe").textContent).toContain("Requires plan");
  });

  it("renders no coloured status dot as the primary status", () => {
    const { container } = render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    // The old design put a green/amber/grey dot on every row. Status is the
    // group's job now; a dot per row said nothing the heading had not.
    const dots = container.querySelectorAll(
      'span.rounded-full.bg-emerald-500, span.rounded-full.bg-amber-500, span.rounded-full.bg-rose-500, span.rounded-full.bg-gray-300',
    );
    expect(dots.length).toBe(0);
  });
});

describe("logos, not letter tiles", () => {
  it("resolves a real logo for a known integration", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    const img = screen.getByTestId("integration-logo-shopify").querySelector("img");
    expect(img).toBeTruthy();
    expect(img!.getAttribute("src")).toMatch(/shopify/i);
    expect(img!.getAttribute("alt")).toBe("Shopify");
  });

  it("ships GOTCHA's own SQUARE mark from the repo, not the wordmark", () => {
    // logo_icon.png is 1526x355 - a wordmark - and collapses to a sliver in a
    // 24px tile. The square app icon is the one that belongs here.
    render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    const img = screen.getByTestId("integration-logo-gotcha").querySelector("img");
    expect(img!.getAttribute("src")).toBe("/apple-touch-icon.png");
  });

  it("falls back to an icon, never a letter tile", () => {
    const s: WorkspaceSidebar = {
      ...sidebar,
      toolIntegrations: { ...sidebar.toolIntegrations, connected: [tool({ id: "custom_api", name: "Custom API" })] },
    };
    render(<IntegrationSidebar sidebar={s} {...base} selectedId="custom_api" />);
    const fb = screen.getByTestId("integration-logo-fallback-custom_api");
    expect(fb.querySelector("svg")).toBeTruthy();
    // The old fallback rendered the first letter. That is the thing to avoid.
    expect(fb.textContent?.trim()).toBe("");
  });
});

describe("selection and separation of concerns", () => {
  it("marks the selected integration for assistive tech, not just visually", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} selectedId="shopify" />);
    expect(screen.getByTestId("sidebar-integration-shopify").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("sidebar-integration-gotcha").getAttribute("aria-current")).toBeNull();
  });

  it("reports selection to the caller", () => {
    const onSelect = vi.fn();
    render(<IntegrationSidebar sidebar={sidebar} {...base} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("sidebar-integration-shopify"));
    expect(onSelect).toHaveBeenCalledWith("shopify");
  });

  it("renders external services as links to their owning screen, with no count", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    const wa = screen.getByTestId("sidebar-external-channel:WHATSAPP");
    expect(wa.tagName).toBe("A");
    expect(wa.getAttribute("href")).toBe("/settings/channels");
    expect(wa.textContent).toContain("Channels");
    // A count here would read as "this has 0 tools", i.e. broken.
    expect(wa.textContent ?? "").not.toMatch(/\d/);
  });

  it("keeps a tool count on tool integrations", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    expect(screen.getByTestId("sidebar-integration-shopify").textContent).toContain("62");
  });

  it("surfaces a missing-scope warning inline", () => {
    const s: WorkspaceSidebar = {
      ...sidebar,
      toolIntegrations: {
        ...sidebar.toolIntegrations,
        connected: [tool({ state: "warning", warning: { reason: "missing_scopes", scopes: ["write_orders"] } })],
      },
    };
    render(<IntegrationSidebar sidebar={s} {...base} />);
    expect(screen.getByText(/missing permissions/i)).toBeTruthy();
  });
});

describe("search is integrations-only", () => {
  it("stays collapsed behind an icon until asked for", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    expect(screen.queryByTestId("integration-search")).toBeNull();
    fireEvent.click(screen.getByTestId("integration-search-toggle"));
    expect(screen.getByTestId("integration-search")).toBeTruthy();
  });

  it("filters integrations, and says so when nothing matches", () => {
    const { unmount } = render(<IntegrationSidebar sidebar={sidebar} {...base} search="hub" />);
    expect(screen.getByTestId("sidebar-integration-hubspot")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-integration-shopify")).toBeNull();
    unmount();
    render(<IntegrationSidebar sidebar={sidebar} {...base} search="zzzz" />);
    expect(screen.getByTestId("sidebar-empty")).toBeTruthy();
  });
});

describe("localization", () => {
  it("renders in Hebrew", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} he={true} />);
    expect(screen.getByText("מחוברים")).toBeTruthy();
    expect(screen.getByText("אינטגרציות זמינות")).toBeTruthy();
    expect(screen.getByText("שירותים מחוברים אחרים")).toBeTruthy();
  });
});
