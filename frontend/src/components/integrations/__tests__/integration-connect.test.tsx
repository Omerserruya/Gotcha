/**
 * Connecting an integration WITHOUT leaving the workspace (spec §3, gate 9).
 *
 * The point of these is that the workspace starts the real flow rather than
 * shipping the reader off to another screen, and that it does so by calling
 * the existing endpoints - there is no second OAuth implementation here, and
 * no per-provider form: the fields come from the catalog.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IntegrationWorkspace } from "../IntegrationWorkspace";

const getIntegrationWorkspace = vi.fn();
const getIntegrationDetail = vi.fn();
const connectIntegration = vi.fn();
const initIntegrationOAuth = vi.fn();

vi.mock("@/lib/api-integration-workspace", async () => {
  const actual = await vi.importActual<any>("@/lib/api-integration-workspace");
  return {
    ...actual,
    getIntegrationWorkspace: (...a: any[]) => getIntegrationWorkspace(...a),
    getIntegrationDetail: (...a: any[]) => getIntegrationDetail(...a),
    connectIntegration: (...a: any[]) => connectIntegration(...a),
    setToolPolicy: vi.fn(),
  };
});
vi.mock("@/lib/api", () => ({ initIntegrationOAuth: (...a: any[]) => initIntegrationOAuth(...a) }));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ token: "tok" }) }));
vi.mock("@/context/I18nContext", () => ({ useI18n: () => ({ locale: "en" }) }));

const entry = (over: any = {}) => ({
  id: "fireberry", name: "Fireberry", kind: "tool_integration", state: "available",
  category: "CRM", description: "A CRM", logoUrl: null, toolCount: 4, ...over,
});

const sidebar = {
  toolIntegrations: { connected: [], available: [entry()], unavailable: [] },
  externalConnections: [],
};

const connectable = (over: any = {}) => ({
  id: "fireberry", name: "Fireberry", internal: false, connected: false, connectable: true,
  description: "A CRM", catalogToolCount: 4,
  authType: "API_KEY",
  authSchema: { fields: [{ key: "tokenid", label: "API Token", type: "password", required: true }] },
  counts: { total: 0, enabled: 0, alwaysAllow: 0, requireApproval: 0, disabled: 0, unavailable: 0 },
  groups: [],
  ...over,
});

beforeEach(() => {
  getIntegrationWorkspace.mockReset();
  getIntegrationDetail.mockReset();
  connectIntegration.mockReset();
  initIntegrationOAuth.mockReset();
  getIntegrationWorkspace.mockResolvedValue({ data: sidebar });
  getIntegrationDetail.mockResolvedValue({ data: connectable() });
});

async function openConnect() {
  render(<IntegrationWorkspace />);
  fireEvent.click(await screen.findByTestId("sidebar-integration-fireberry"));
  fireEvent.click(await screen.findByTestId("integration-connect-cta"));
  return screen.findByTestId("connect-dialog");
}

describe("credential providers connect in place", () => {
  it("renders the fields the CATALOG declares, not a hardcoded form", async () => {
    await openConnect();
    expect(screen.getByTestId("connect-field-tokenid")).toBeTruthy();
    // A password field must not be a plain text input.
    expect((screen.getByTestId("connect-field-tokenid") as HTMLInputElement).type).toBe("password");
  });

  it("will not submit while a required field is empty", async () => {
    await openConnect();
    expect((screen.getByTestId("connect-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(connectIntegration).not.toHaveBeenCalled();
  });

  it("posts the credentials to the existing connect endpoint and re-reads", async () => {
    connectIntegration.mockResolvedValue({ data: {} });
    await openConnect();
    fireEvent.change(screen.getByTestId("connect-field-tokenid"), { target: { value: "secret-token" } });
    fireEvent.click(screen.getByTestId("connect-submit"));
    await waitFor(() => expect(connectIntegration).toHaveBeenCalled());
    const [, slug, creds] = connectIntegration.mock.calls[0];
    expect(slug).toBe("fireberry");
    expect(creds).toEqual({ tokenid: "secret-token" });
    // Connected is what the SERVER says, so the workspace re-reads.
    await waitFor(() => expect(getIntegrationWorkspace).toHaveBeenCalledTimes(2));
  });

  it("keeps the provider's own failure reason", async () => {
    connectIntegration.mockRejectedValue(new Error("invalid_api_key"));
    await openConnect();
    fireEvent.change(screen.getByTestId("connect-field-tokenid"), { target: { value: "bad" } });
    fireEvent.click(screen.getByTestId("connect-submit"));
    expect((await screen.findByTestId("connect-error")).textContent).toContain("invalid_api_key");
  });

  it("does not claim success when the connection failed", async () => {
    connectIntegration.mockRejectedValue(new Error("nope"));
    await openConnect();
    fireEvent.change(screen.getByTestId("connect-field-tokenid"), { target: { value: "bad" } });
    fireEvent.click(screen.getByTestId("connect-submit"));
    await screen.findByTestId("connect-error");
    // Still open, still showing the form - nothing was re-read as connected.
    expect(screen.getByTestId("connect-dialog")).toBeTruthy();
    expect(getIntegrationWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe("OAuth providers hand off to the one real init endpoint", () => {
  const shopify = connectable({
    id: "shopify", name: "Shopify", authType: "OAUTH2",
    authSchema: {
      oauth: true,
      fields: [{ key: "shop", label: "Shop domain", type: "text", required: true, placeholder: "my-store.myshopify.com" }],
      scopes: ["read_orders", "write_orders"],
    },
  });

  beforeEach(() => {
    getIntegrationWorkspace.mockResolvedValue({
      data: { toolIntegrations: { connected: [], available: [entry({ id: "shopify", name: "Shopify" })], unavailable: [] }, externalConnections: [] },
    });
    getIntegrationDetail.mockResolvedValue({ data: shopify });
  });

  async function openShopify() {
    render(<IntegrationWorkspace />);
    fireEvent.click(await screen.findByTestId("sidebar-integration-shopify"));
    fireEvent.click(await screen.findByTestId("integration-connect-cta"));
    return screen.findByTestId("connect-dialog");
  }

  it("says the reader is about to leave for the provider", async () => {
    await openShopify();
    expect(screen.getByTestId("connect-oauth-note")).toBeTruthy();
  });

  it("shows which scopes are being requested", async () => {
    await openShopify();
    expect(screen.getByTestId("connect-scopes").textContent).toContain("write_orders");
  });

  it("passes the catalog's pre-flight field to init, never building a consent URL itself", async () => {
    initIntegrationOAuth.mockResolvedValue({ url: "https://shopify.example/oauth" });
    await openShopify();
    fireEvent.change(screen.getByTestId("connect-field-shop"), { target: { value: "urban.myshopify.com" } });
    fireEvent.click(screen.getByTestId("connect-submit"));
    await waitFor(() => expect(initIntegrationOAuth).toHaveBeenCalled());
    const [, slug, params] = initIntegrationOAuth.mock.calls[0];
    expect(slug).toBe("shopify");
    expect(params).toEqual({ shop: "urban.myshopify.com" });
    // The credential endpoint is NOT used for an OAuth provider.
    expect(connectIntegration).not.toHaveBeenCalled();
  });

  it("reports a failure to start rather than navigating nowhere", async () => {
    initIntegrationOAuth.mockResolvedValue({ url: "" });
    await openShopify();
    fireEvent.change(screen.getByTestId("connect-field-shop"), { target: { value: "urban.myshopify.com" } });
    fireEvent.click(screen.getByTestId("connect-submit"));
    expect(await screen.findByTestId("connect-error")).toBeTruthy();
  });
});
