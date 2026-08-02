import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IntegrationSidebar } from "../IntegrationSidebar";
import type { WorkspaceEntry, WorkspaceSidebar } from "@/lib/api-integration-workspace";

const tool = (over: Partial<WorkspaceEntry>): WorkspaceEntry => ({
  id: "shopify", name: "Shopify", kind: "tool_integration", state: "connected",
  category: "ECOMMERCE", description: null, logoUrl: null, toolCount: 62, ...over,
});
const external = (over: Partial<WorkspaceEntry>): WorkspaceEntry => ({
  id: "knowledge:google_drive", name: "Google Drive", kind: "external_connection", state: "connected",
  category: "Knowledge source", description: null, logoUrl: null, toolCount: null,
  owner: "knowledge", href: "/ai-studio/knowledge", ...over,
});

const sidebar: WorkspaceSidebar = {
  toolIntegrations: {
    connected: [tool({ id: "gotcha", name: "GOTCHA", toolCount: 23, internal: true }), tool({})],
    available: [tool({ id: "hubspot", name: "HubSpot", toolCount: 10, state: "available" })],
    unavailable: [tool({ id: "stripe", name: "Stripe", toolCount: 5, state: "not_entitled" })],
  },
  externalConnections: [
    external({}),
    // A CONNECTED provider with no governable tools: real, but managed on its
    // own setup page. Channels are not in this list at all any more.
    external({ id: "custom_api", name: "Custom API", owner: "integration_setup", href: "/settings/business-systems/custom_api", category: "OTHER" }),
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
      // Emptied so the one custom_api row under test is unambiguous - the
      // fixture's external list carries a custom_api entry of its own.
      externalConnections: [],
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
    const drive = screen.getByTestId("sidebar-external-knowledge:google_drive");
    expect(drive.tagName).toBe("A");
    expect(drive.getAttribute("href")).toBe("/ai-studio/knowledge");
    expect(drive.textContent).toContain("Knowledge");
    // A count here would read as "this has 0 tools", i.e. broken.
    expect(drive.textContent ?? "").not.toMatch(/\d/);
  });

  it("sends a tool-less business system to its own setup page, not to Channels", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    const api = screen.getByTestId("sidebar-external-custom_api");
    expect(api.getAttribute("href")).toBe("/settings/business-systems/custom_api");
    expect(api.textContent).toContain("Setup");
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
