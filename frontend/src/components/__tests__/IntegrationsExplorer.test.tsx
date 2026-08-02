/**
 * Issue-7 regression: CRM / customer-system-of-record entries are a business
 * architecture choice, NOT generic tools. The generic marketplace must not
 * list them (nor offer a CRM category chip); the Settings surface restricted
 * to CRM remains their home and still includes canActAsCrm systems (Shopify).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import IntegrationsExplorer from "../IntegrationsExplorer";

vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ token: "test-token" }),
}));
vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const CATALOG = [
  { id: "1", slug: "hubspot", name: "HubSpot", description: "CRM", category: "CRM", authType: "OAUTH2", isPublished: true },
  { id: "2", slug: "fireberry", name: "Fireberry", description: "CRM", category: "CRM", authType: "API_KEY", isPublished: true },
  { id: "3", slug: "shopify", name: "Shopify", description: "Store", category: "ECOMMERCE", authType: "OAUTH2", canActAsCrm: true, isPublished: true },
  { id: "4", slug: "stripe", name: "Stripe", description: "Payments", category: "PAYMENTS", authType: "API_KEY", isPublished: true },
];

vi.mock("@/lib/api", () => ({
  getMarketplaceIntegrations: vi.fn(() => Promise.resolve({ data: CATALOG })),
}));

describe("IntegrationsExplorer category separation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("generic marketplace hides CRM systems and the CRM chip", async () => {
    render(<IntegrationsExplorer />);
    await waitFor(() => expect(screen.getByText("Stripe")).toBeInTheDocument());
    // CRM entries gone from the generic surface…
    expect(screen.queryByText("HubSpot")).not.toBeInTheDocument();
    expect(screen.queryByText("Fireberry")).not.toBeInTheDocument();
    // …but real tools (incl. Shopify as an ECOMMERCE tool) remain.
    expect(screen.getByText("Shopify")).toBeInTheDocument();
    // No CRM category chip to reach them through.
    expect(screen.queryByRole("button", { name: "CRM" })).not.toBeInTheDocument();
    // And a pointer to the proper home exists.
    expect(screen.getByText("marketplace.crmMovedLink")).toBeInTheDocument();
  });

  it("CRM-restricted surface (Settings) still shows CRMs + canActAsCrm systems", async () => {
    render(<IntegrationsExplorer restrictToCategory="CRM" />);
    await waitFor(() => expect(screen.getByText("HubSpot")).toBeInTheDocument());
    expect(screen.getByText("Fireberry")).toBeInTheDocument();
    // Shopify passes the CRM filter via canActAsCrm (source-of-truth election).
    expect(screen.getByText("Shopify")).toBeInTheDocument();
    // Non-CRM tools do not leak in.
    expect(screen.queryByText("Stripe")).not.toBeInTheDocument();
    // The restricted surface has no reason to show the "moved" hint.
    expect(screen.queryByText("marketplace.crmMovedLink")).not.toBeInTheDocument();
  });
});
