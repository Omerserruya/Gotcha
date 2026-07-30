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

describe("IntegrationSidebar keeps the two kinds visually and functionally apart", () => {
  it("renders tool integrations as selectable and external ones as links", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    // Selectable.
    expect(screen.getByTestId("sidebar-integration-shopify").tagName).toBe("BUTTON");
    // Not selectable here - it opens the screen that owns it.
    const wa = screen.getByTestId("sidebar-external-channel:WHATSAPP");
    expect(wa.tagName).toBe("A");
    expect(wa.getAttribute("href")).toBe("/settings/channels");
  });

  it("shows a tool count for tool integrations only", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    expect(screen.getByTestId("sidebar-integration-shopify").textContent).toContain("62");
    // No digits at all on an external row: a count there would read as
    // "this has 0 tools", i.e. broken.
    const wa = screen.getByTestId("sidebar-external-channel:WHATSAPP").textContent ?? "";
    expect(wa).not.toMatch(/\d/);
  });

  it("says where an external service is managed", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    expect(screen.getByTestId("sidebar-external-channel:WHATSAPP").textContent).toContain("Channels");
    expect(screen.getByTestId("sidebar-external-knowledge:google_drive").textContent).toContain("Knowledge");
  });

  it("groups connected, available and not-usable separately", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getByText("Not usable now")).toBeTruthy();
    expect(screen.getByText("Other connected services")).toBeTruthy();
  });

  it("states that no tool permissions live in the external group", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} />);
    expect(screen.getByText(/No tool permissions here/i)).toBeTruthy();
  });

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

  it("filters on search, and says so when nothing matches", () => {
    const { unmount } = render(<IntegrationSidebar sidebar={sidebar} {...base} search="hub" />);
    expect(screen.getByTestId("sidebar-integration-hubspot")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-integration-shopify")).toBeNull();
    unmount();
    render(<IntegrationSidebar sidebar={sidebar} {...base} search="zzzz" />);
    expect(screen.getByTestId("sidebar-empty")).toBeTruthy();
  });

  it("renders in Hebrew", () => {
    render(<IntegrationSidebar sidebar={sidebar} {...base} he={true} />);
    expect(screen.getByText("מחוברים")).toBeTruthy();
    expect(screen.getByText("שירותים מחוברים אחרים")).toBeTruthy();
  });
});
