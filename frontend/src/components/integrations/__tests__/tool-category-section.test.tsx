import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ToolCategorySection, type CategoryTool } from "../ToolCategorySection";

const tool = (over: Partial<CategoryTool> = {}): CategoryTool => ({
  name: "shopify.get_order",
  displayName: "Get order",
  description: "Retrieve a single Shopify order by id",
  state: "always_allow",
  unavailable: false,
  ...over,
});

const base = {
  group: "read_only" as const,
  title: "Read-only tools",
  he: false,
  showRawName: false,
  defaultOpen: true,
  onChangeTool: () => {},
  onApplyGroup: () => {},
};

describe("one container per category, not one card per tool", () => {
  it("renders every row inside a single container", () => {
    render(<ToolCategorySection {...base} tools={[tool(), tool({ name: "b", displayName: "B" }), tool({ name: "c", displayName: "C" })]} />);
    const panel = screen.getByTestId("category-panel-read_only");
    expect(within(panel).getAllByTestId(/^tool-row-/).length).toBe(3);
  });

  it("shows the tool count beside the title", () => {
    render(<ToolCategorySection {...base} tools={[tool(), tool({ name: "b" })]} />);
    expect(screen.getByTestId("category-toggle-read_only").textContent).toContain("2");
  });

  it("collapses and expands, and reports state to assistive tech", () => {
    render(<ToolCategorySection {...base} tools={[tool()]} />);
    const toggle = screen.getByTestId("category-toggle-read_only");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("category-panel-read_only")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId("category-panel-read_only")).toBeTruthy();
  });

  it("can start collapsed", () => {
    render(<ToolCategorySection {...base} defaultOpen={false} tools={[tool()]} />);
    expect(screen.queryByTestId("category-panel-read_only")).toBeNull();
  });
});

describe("the segmented control is one control", () => {
  it("is a radiogroup with exactly three options and one selected", () => {
    render(<ToolCategorySection {...base} tools={[tool({ state: "require_approval" })]} />);
    const group = screen.getByTestId("segmented-shopify.get_order");
    expect(group.getAttribute("role")).toBe("radiogroup");
    const radios = within(group).getAllByRole("radio");
    expect(radios.length).toBe(3);
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true").length).toBe(1);
    expect(screen.getByTestId("state-require_approval-shopify.get_order").getAttribute("aria-checked")).toBe("true");
  });

  it("labels every option and explains it in a tooltip", () => {
    render(<ToolCategorySection {...base} tools={[tool()]} />);
    const auto = screen.getByTestId("state-always_allow-shopify.get_order");
    expect(auto.getAttribute("aria-label")).toBe("Autonomous");
    expect(auto.getAttribute("title")).toMatch(/automatically/i);
    expect(screen.getByTestId("state-require_approval-shopify.get_order").getAttribute("title")).toMatch(/approval/i);
    expect(screen.getByTestId("state-disabled-shopify.get_order").getAttribute("title")).toMatch(/cannot be used/i);
  });

  it("exposes one tab stop and moves with arrow keys", () => {
    const onChangeTool = vi.fn();
    render(<ToolCategorySection {...base} onChangeTool={onChangeTool} tools={[tool({ state: "always_allow" })]} />);
    const group = screen.getByTestId("segmented-shopify.get_order");
    const radios = within(group).getAllByRole("radio");
    // Roving tabindex: only the selected segment is reachable by Tab.
    expect(radios.filter((r) => r.getAttribute("tabindex") === "0").length).toBe(1);
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(onChangeTool).toHaveBeenCalledWith(expect.anything(), "require_approval");
  });

  it("reports a click as the chosen mode", () => {
    const onChangeTool = vi.fn();
    render(<ToolCategorySection {...base} onChangeTool={onChangeTool} tools={[tool({ state: "always_allow" })]} />);
    fireEvent.click(screen.getByTestId("state-disabled-shopify.get_order"));
    expect(onChangeTool).toHaveBeenCalledWith(expect.anything(), "disabled");
  });

  it("locks a mode the tool may not take, and says why", () => {
    const onChangeTool = vi.fn();
    render(
      <ToolCategorySection
        {...base}
        group="financial"
        onChangeTool={onChangeTool}
        tools={[tool({ state: "require_approval", lockedStates: { always_allow: "Refunds always need approval" } })]}
      />,
    );
    const auto = screen.getByTestId("state-always_allow-shopify.get_order") as HTMLButtonElement;
    expect(auto.disabled).toBe(true);
    expect(auto.getAttribute("title")).toBe("Refunds always need approval");
    fireEvent.click(auto);
    expect(onChangeTool).not.toHaveBeenCalled();
  });
});

describe("availability is not a permission choice", () => {
  it("shows the real reason and does not present it as user-disabled", () => {
    render(
      <ToolCategorySection
        {...base}
        tools={[tool({ state: "unavailable", unavailable: true, unavailableReason: "Missing provider permissions: write_orders" })]}
      />,
    );
    expect(screen.getByTestId("tool-unavailable-shopify.get_order").textContent).toContain("write_orders");
    // None of the three modes may claim to be the current selection.
    const group = screen.getByTestId("segmented-shopify.get_order");
    expect(within(group).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true").length).toBe(0);
    expect(group.getAttribute("aria-disabled")).toBe("true");
  });

  it("leaves the whole control inert while unavailable", () => {
    const onChangeTool = vi.fn();
    render(
      <ToolCategorySection
        {...base}
        onChangeTool={onChangeTool}
        tools={[tool({ state: "unavailable", unavailable: true, unavailableReason: "Integration disconnected" })]}
      />,
    );
    fireEvent.click(screen.getByTestId("state-always_allow-shopify.get_order"));
    expect(onChangeTool).not.toHaveBeenCalled();
  });
});

describe("group-level control", () => {
  it("shows the shared mode when every tool agrees", () => {
    render(<ToolCategorySection {...base} tools={[tool(), tool({ name: "b" })]} />);
    const ctl = screen.getByTestId("group-control-read_only");
    expect(ctl.getAttribute("data-mode")).toBe("always_allow");
    expect(ctl.textContent).toContain("Always allow");
  });

  it("shows Mixed when they differ", () => {
    render(<ToolCategorySection {...base} tools={[tool(), tool({ name: "b", state: "disabled" })]} />);
    const ctl = screen.getByTestId("group-control-read_only");
    expect(ctl.getAttribute("data-mode")).toBe("mixed");
    expect(ctl.textContent).toContain("Mixed");
  });

  it("ignores unavailable tools when deciding Mixed", () => {
    // An unavailable tool has no user choice, so letting it vote would report
    // Mixed for a group the admin has set consistently.
    render(
      <ToolCategorySection
        {...base}
        tools={[tool(), tool({ name: "b", state: "unavailable", unavailable: true, unavailableReason: "Integration disconnected" })]}
      />,
    );
    expect(screen.getByTestId("group-control-read_only").getAttribute("data-mode")).toBe("always_allow");
  });

  it("applies a mode to the whole group", () => {
    const onApplyGroup = vi.fn();
    render(<ToolCategorySection {...base} onApplyGroup={onApplyGroup} tools={[tool()]} />);
    fireEvent.click(screen.getByTestId("group-control-read_only"));
    fireEvent.click(screen.getByTestId("group-apply-disabled-read_only"));
    expect(onApplyGroup).toHaveBeenCalledWith("disabled");
  });

  it("is disabled when the group has nothing governable", () => {
    render(
      <ToolCategorySection
        {...base}
        tools={[tool({ state: "unavailable", unavailable: true, unavailableReason: "Not included in your plan" })]}
      />,
    );
    expect((screen.getByTestId("group-control-read_only") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("row content", () => {
  it("uses the localized name as the label, never the raw identifier", () => {
    render(<ToolCategorySection {...base} tools={[tool()]} />);
    const row = screen.getByTestId("tool-row-shopify.get_order");
    expect(row.textContent).toContain("Get order");
    expect(row.textContent).not.toContain("shopify.get_order");
  });

  it("reveals the raw id only in diagnostics mode", () => {
    render(<ToolCategorySection {...base} showRawName tools={[tool()]} />);
    expect(screen.getByTestId("tool-row-shopify.get_order").textContent).toContain("shopify.get_order");
  });

  it("renders Hebrew labels", () => {
    render(<ToolCategorySection {...base} he tools={[tool()]} />);
    expect(screen.getByTestId("state-always_allow-shopify.get_order").getAttribute("aria-label")).toBe("אוטונומי");
    expect(screen.getByTestId("group-control-read_only").textContent).toContain("תמיד מאושר");
  });
});
