import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  ToolPermissionRow,
  IntegrationToolSummary,
  RiskGroupHeading,
} from "../ToolPermissionRow";
import { resolveToolAvailability, summarizeTools } from "@/lib/tool-availability-client";

const avail = (over: Parameters<typeof resolveToolAvailability>[0]) => resolveToolAvailability(over);

describe("ToolPermissionRow - an unavailable tool is never shown as 'you turned it off'", () => {
  it("names a missing provider scope and offers the matching fix", () => {
    render(
      <ToolPermissionRow
        displayName="Create order"
        rawName="shopify.create_order"
        availability={avail({
          toolName: "shopify.create_order", enabled: true, requiresApproval: true,
          requiredScopes: ["write_orders"], grantedScopes: [],
        })}
        he={false}
      />,
    );
    expect(screen.getByTestId("unavailable-shopify.create_order")).toBeTruthy();
    expect(screen.getByText(/Missing provider permissions: write_orders/)).toBeTruthy();
    expect(screen.getByText("Grant access")).toBeTruthy();
    // Crucially, there is no permission switch to mislead them with.
    expect(screen.queryByTestId("state-disabled-shopify.create_order")).toBeNull();
  });

  it("distinguishes a plan gap from a disconnected integration", () => {
    const { unmount } = render(
      <ToolPermissionRow displayName="Refund" rawName="issue_refund" he={false}
        availability={avail({ toolName: "issue_refund", enabled: true, requiresApproval: true, planEntitled: false })} />,
    );
    expect(screen.getByText("Not included in your plan")).toBeTruthy();
    expect(screen.getByText("Upgrade plan")).toBeTruthy();
    unmount();

    render(
      <ToolPermissionRow displayName="Refund" rawName="issue_refund" he={false}
        availability={avail({ toolName: "issue_refund", enabled: true, requiresApproval: true, integrationConnected: false })} />,
    );
    expect(screen.getByText("The integration is disconnected")).toBeTruthy();
    expect(screen.getByText("Reconnect")).toBeTruthy();
  });

  it("shows the three real states for an available tool", () => {
    render(
      <ToolPermissionRow displayName="Look up contact" rawName="get_contact" he={false}
        availability={avail({ toolName: "get_contact", enabled: true, requiresApproval: false })} />,
    );
    expect(screen.getByTestId("state-always_allow-get_contact").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("state-require_approval-get_contact").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("state-disabled-get_contact")).toBeTruthy();
  });

  it("refuses always-allow on an irreversible action", () => {
    render(
      <ToolPermissionRow displayName="Refund" rawName="issue_refund" he={false}
        availability={avail({ toolName: "issue_refund", enabled: true, requiresApproval: true })} />,
    );
    const alwaysAllow = screen.getByTestId("state-always_allow-issue_refund") as HTMLButtonElement;
    expect(alwaysAllow.disabled).toBe(true);
    expect(alwaysAllow.getAttribute("title")).toMatch(/irreversible/i);
  });

  it("reports the chosen state back to the caller", () => {
    const onChange = vi.fn();
    render(
      <ToolPermissionRow displayName="Send message" rawName="send_message" he={false} onChange={onChange}
        availability={avail({ toolName: "send_message", enabled: true, requiresApproval: false })} />,
    );
    fireEvent.click(screen.getByTestId("state-require_approval-send_message"));
    expect(onChange).toHaveBeenCalledWith("require_approval");
  });

  it("keeps the raw adapter identifier out of the way until diagnostics ask for it", () => {
    const props = {
      displayName: "Look up contact", rawName: "get_contact", he: false,
      availability: avail({ toolName: "get_contact", enabled: true, requiresApproval: false }),
    };
    const { unmount } = render(<ToolPermissionRow {...props} />);
    expect(screen.queryByTestId("raw-name-get_contact")).toBeNull();
    unmount();
    render(<ToolPermissionRow {...props} showRawName />);
    expect(screen.getByTestId("raw-name-get_contact").textContent).toBe("get_contact");
  });

  it("speaks Hebrew", () => {
    render(
      <ToolPermissionRow displayName="החזר כספי" rawName="issue_refund" he={true}
        availability={avail({ toolName: "issue_refund", enabled: true, requiresApproval: true, planEntitled: false })} />,
    );
    expect(screen.getByText("לא נכלל בתוכנית שלכם")).toBeTruthy();
  });
});

describe("IntegrationToolSummary - the headline must be true", () => {
  const counts = summarizeTools([
    avail({ toolName: "get_contact", enabled: true, requiresApproval: false }),
    avail({ toolName: "send_message", enabled: true, requiresApproval: true }),
    avail({ toolName: "create_task", enabled: false, requiresApproval: true }),
    avail({ toolName: "shopify.create_order", enabled: true, requiresApproval: true, planEntitled: false }),
  ]);

  it("counts only what can actually run", () => {
    render(<IntegrationToolSummary name="Shopify" connected counts={counts} he={false} />);
    expect(screen.getByTestId("tool-count").textContent).toBe("2 of 4 tools enabled");
  });

  it("calls out unavailable separately from off", () => {
    render(<IntegrationToolSummary name="Shopify" connected counts={counts} he={false} />);
    expect(screen.getByTestId("chip-unavailable").textContent).toMatch(/1 unavailable/);
    expect(screen.getByTestId("chip-disabled").textContent).toMatch(/1 off/);
    expect(screen.getByTestId("chip-approval").textContent).toMatch(/1 need approval/);
  });

  it("shows connection health and a reconnect path", () => {
    const onReconnect = vi.fn();
    render(<IntegrationToolSummary name="Shopify" connected={false} counts={counts} he={false} onReconnect={onReconnect} />);
    expect(screen.getByTestId("integration-connection").textContent).toBe("Disconnected");
    fireEvent.click(screen.getByText("Reconnect"));
    expect(onReconnect).toHaveBeenCalled();
  });

  it("localizes the headline", () => {
    render(<IntegrationToolSummary name="Shopify" connected counts={counts} he={true} />);
    expect(screen.getByTestId("tool-count").textContent).toContain("מתוך");
  });
});

describe("RiskGroupHeading", () => {
  it("labels and explains each group", () => {
    render(<RiskGroupHeading group="financial" count={3} he={false} />);
    expect(screen.getByTestId("risk-group-financial")).toBeTruthy();
    expect(screen.getByText("Financial and irreversible")).toBeTruthy();
    expect(screen.getByText(/Moves money/)).toBeTruthy();
  });

  it("localizes", () => {
    render(<RiskGroupHeading group="read_only" count={1} he={true} />);
    expect(screen.getByText("קריאה בלבד")).toBeTruthy();
  });
});
