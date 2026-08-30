/**
 * Regression: ConnectScreen once declared a useState AFTER the `justConnected`
 * early return, so the hook count changed between renders the moment an OAuth
 * return (Shopify et al.) toggled that flag - React crashed the whole wizard
 * with "Rendered more hooks than during the previous render".
 *
 * These tests drive the exact render-branch transitions of that incident:
 * normal → ✓-connected → normal, across every branch combination
 * (primary detected / not, picked / not). A hook-order violation makes
 * React throw during rerender, failing the test.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectScreen, SYSTEMS } from "../connect-screen";
import type { ComponentProps } from "react";

type Props = ComponentProps<typeof ConnectScreen>;

const baseProps = (): Props => ({
  he: false,
  systemQuery: "",
  setSystemQuery: vi.fn(),
  picked: null,
  setPicked: vi.fn(),
  fireberryToken: "",
  setFireberryToken: vi.fn(),
  airtableToken: "",
  setAirtableToken: vi.fn(),
  connecting: false,
  skipping: false,
  onConnect: vi.fn(),
  onBack: vi.fn(),
  onSkip: vi.fn(),
  onRequestCrm: vi.fn().mockResolvedValue(undefined),
  justConnected: null,
  onContinueConnected: vi.fn(),
  rec: null,
  disc: null,
});

// A discovery record whose detected platform maps to the Shopify tile, so the
// "primary card" branch renders (a different hook-visible branch than the
// full-catalog one).
const discWithShopify = { technology: { platform: { slug: "shopify", name: "Shopify" } } } as unknown as Props["disc"];

describe("ConnectScreen hook-order stability", () => {
  it("survives normal → justConnected → normal (the OAuth-return transition)", () => {
    const props = baseProps();
    const { rerender } = render(<ConnectScreen {...props} />);
    expect(screen.getByText("Where do you manage your customers?")).toBeInTheDocument();

    // OAuth return flips justConnected on the SAME mounted element.
    rerender(<ConnectScreen {...props} justConnected="shopify" />);
    expect(screen.getByText("Shopify is connected!")).toBeInTheDocument();

    // "Continue" clears it again (continueAfterConnect) - back to the catalog.
    rerender(<ConnectScreen {...props} justConnected={null} />);
    expect(screen.getByText("Where do you manage your customers?")).toBeInTheDocument();
  });

  it("survives the transition when a detected primary exists (primary-card branch)", () => {
    const props = { ...baseProps(), disc: discWithShopify };
    const { rerender } = render(<ConnectScreen {...props} />);
    // Primary-card branch: single large Shopify tile, no search input.
    expect(screen.queryByPlaceholderText("Search systems…")).not.toBeInTheDocument();

    rerender(<ConnectScreen {...props} justConnected="shopify" />);
    expect(screen.getByText("Shopify is connected!")).toBeInTheDocument();

    rerender(<ConnectScreen {...props} justConnected={null} />);
    expect(screen.queryByText("Shopify is connected!")).not.toBeInTheDocument();
  });

  it("mounts directly on the ✓-connected branch and can leave it (deep-link render order)", () => {
    const props = baseProps();
    const { rerender } = render(<ConnectScreen {...props} justConnected="fireberry" />);
    expect(screen.getByText("Fireberry is connected!")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Continue →"));
    expect(props.onContinueConnected).toHaveBeenCalledTimes(1);

    // Fewer→more hooks direction of the original crash.
    rerender(<ConnectScreen {...props} justConnected={null} />);
    expect(screen.getByText("Where do you manage your customers?")).toBeInTheDocument();
  });

  it("arriving preselected from Movement 5 shows the picked tile in the full catalog", () => {
    const props = { ...baseProps(), disc: discWithShopify, picked: "fireberry" as Props["picked"] };
    render(<ConnectScreen {...props} />);
    // picked !== primary → full catalog (search visible) with the Fireberry tile present.
    expect(screen.getByPlaceholderText("Search systems…")).toBeInTheDocument();
    expect(screen.getByText("Fireberry")).toBeInTheDocument();
    // Fireberry is API-token: its token field renders for the picked tile.
    expect(screen.getByPlaceholderText("API token (tokenid)")).toBeInTheDocument();
  });

  it("catalog search filters systems (controlled systemQuery prop)", () => {
    const props = { ...baseProps(), systemQuery: "fireberry" };
    render(<ConnectScreen {...props} />);
    expect(screen.getByText("Fireberry")).toBeInTheDocument();
    expect(screen.queryByText("HubSpot")).not.toBeInTheDocument();
  });

  it("exposes all six core systems in the catalog", () => {
    expect(SYSTEMS.map((s) => s.slug)).toEqual(
      expect.arrayContaining(["hubspot", "salesforce", "zoho_crm", "fireberry", "airtable", "shopify"]),
    );
  });
});
