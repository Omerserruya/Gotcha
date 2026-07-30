/**
 * The commerce panel's ACTIONS, not its layout.
 *
 * The thing worth protecting here is that a button never claims more than the
 * backend confirmed, and never sends more than the agent chose. The original
 * panel had exactly that bug: the Refund button fired a request with no params,
 * so a partial refund was impossible and every click was a FULL refund of the
 * order - with no way for the agent to say otherwise.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommerceContextPanel } from "../CommerceContextPanel";

const runCommerceAction = vi.fn();
const fetchCommerceContext = vi.fn();

vi.mock("@/lib/api-commerce", async () => {
  const actual = await vi.importActual<any>("@/lib/api-commerce");
  return {
    ...actual,
    fetchCommerceContext: (...a: any[]) => fetchCommerceContext(...a),
    runCommerceAction: (...a: any[]) => runCommerceAction(...a),
    commerceIdemKey: (c: string, s: string, a: string) => `${c}:${s}:${a}:fixed`,
  };
});

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" }),
}));

const chip = (key: string) => ({ key, label: key, tone: "neutral" as const });

const order = (over: Record<string, any> = {}) => ({
  orderId: "gid://1", orderNumber: "#1001", adminUrl: "https://admin/1",
  createdAt: "2026-07-01T00:00:00.000Z",
  total: { amount: "100.00", currency: "USD" },
  financial: chip("paid"), fulfillment: chip("unfulfilled"),
  cancelled: false, refund: null, shipping: null,
  items: [{ title: "A shirt", quantity: 1, imageUrl: null }],
  extraItemCount: 0,
  refundedAmount: { amount: "0.00", currency: "USD" },
  refundableMaximum: { amount: "100.00", currency: "USD" },
  timeline: [],
  eligibility: { cancellable: true, refundable: true },
  ...over,
});

const caps = (over: Record<string, any> = {}) => ({
  canOpen: true, canCancel: true, canRefund: true, canTag: true, canNote: true,
  grantedScopes: ["read_orders", "write_orders", "write_customers"],
  lastCheckedAt: null, missingScopes: [], ...over,
});

const okContext = (over: Record<string, any> = {}) => ({
  state: "ok",
  data: {
    provider: "shopify",
    customer: { verified: true, customerId: "c1", tags: ["vip"] },
    summary: {
      orderCount: 1, totalSpentByCurrency: [], shopCurrencyTotal: null,
      lastOrderAt: null, repeatCustomer: false, openOrderCount: 1, refundedOrCancelledCount: 0,
    },
    capabilities: caps(),
    recentOrders: [order()],
    fetchedAt: "2026-07-01T00:00:00.000Z",
    cacheTtlSeconds: 60,
    ...over,
  },
});

const renderPanel = () =>
  render(<CommerceContextPanel conversationId="conv1" token="tok" />);

beforeEach(() => {
  runCommerceAction.mockReset();
  fetchCommerceContext.mockReset();
  fetchCommerceContext.mockResolvedValue(okContext());
});

async function openRefund() {
  renderPanel();
  await screen.findByText("#1001");
  fireEvent.click(screen.getByText("commerce.refund"));
  await screen.findByTestId("refund-submit");
}

describe("refund: full vs partial is the agent's choice, not an assumption", () => {
  it("a partial refund sends the amount the agent typed", async () => {
    runCommerceAction.mockResolvedValue({ state: "executed", order: order() });
    await openRefund();
    fireEvent.click(screen.getByTestId("refund-mode-partial"));
    fireEvent.change(screen.getByTestId("refund-amount"), { target: { value: "25.50" } });
    fireEvent.click(screen.getByTestId("refund-submit"));

    await waitFor(() => expect(runCommerceAction).toHaveBeenCalled());
    const [, , input] = runCommerceAction.mock.calls[0];
    expect(input.action).toBe("refund");
    expect(input.params.amount).toBe(25.5);
  });

  it("a full refund sends NO amount, so the backend refunds the true remainder", async () => {
    // Sending the displayed total would be wrong the moment a partial refund
    // already happened - the server knows the refundable remainder, we do not.
    runCommerceAction.mockResolvedValue({ state: "executed", order: order() });
    await openRefund();
    fireEvent.click(screen.getByTestId("refund-submit"));
    await waitFor(() => expect(runCommerceAction).toHaveBeenCalled());
    expect(runCommerceAction.mock.calls[0][2].params.amount).toBeUndefined();
  });

  it("refuses to submit more than the refundable maximum", async () => {
    await openRefund();
    fireEvent.click(screen.getByTestId("refund-mode-partial"));
    fireEvent.change(screen.getByTestId("refund-amount"), { target: { value: "999" } });
    expect(screen.getByTestId("refund-over-max")).toBeTruthy();
    expect((screen.getByTestId("refund-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("refund-submit"));
    expect(runCommerceAction).not.toHaveBeenCalled();
  });

  it("refuses to submit a partial refund with no amount", async () => {
    await openRefund();
    fireEvent.click(screen.getByTestId("refund-mode-partial"));
    expect((screen.getByTestId("refund-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("passes restock, shipping and notify as explicit choices", async () => {
    runCommerceAction.mockResolvedValue({ state: "executed", order: order() });
    await openRefund();
    fireEvent.click(screen.getByTestId("refund-restock"));
    fireEvent.click(screen.getByTestId("refund-shipping"));
    fireEvent.click(screen.getByTestId("refund-notify")); // on by default → off
    fireEvent.click(screen.getByTestId("refund-submit"));
    await waitFor(() => expect(runCommerceAction).toHaveBeenCalled());
    const p = runCommerceAction.mock.calls[0][2].params;
    expect(p.restock).toBe(true);
    expect(p.refundShipping).toBe(true);
    expect(p.notify).toBe(false);
  });
});

describe("cancel is not a refund", () => {
  it("sends restock and never an amount", async () => {
    runCommerceAction.mockResolvedValue({ state: "executed", order: order() });
    renderPanel();
    await screen.findByText("#1001");
    fireEvent.click(screen.getByText("commerce.cancel"));
    fireEvent.click(await screen.findByTestId("cancel-submit"));
    await waitFor(() => expect(runCommerceAction).toHaveBeenCalled());
    const input = runCommerceAction.mock.calls[0][2];
    expect(input.action).toBe("cancel");
    expect(input.params.amount).toBeUndefined();
    expect(input.params.restock).toBe(true);
  });

  it("says out loud that cancelling does not refund", async () => {
    renderPanel();
    await screen.findByText("#1001");
    fireEvent.click(screen.getByText("commerce.cancel"));
    expect(await screen.findByText("commerce.cancelDoesNotRefund")).toBeTruthy();
  });
});

describe("the panel reports only what the server confirmed", () => {
  it("a pending approval is NOT shown as done", async () => {
    runCommerceAction.mockResolvedValue({ state: "pending_approval", approvalRequestId: "a1" });
    await openRefund();
    fireEvent.click(screen.getByTestId("refund-submit"));
    expect(await screen.findByText("commerce.pendingApproval")).toBeTruthy();
    expect(screen.queryByText("commerce.actionDone")).toBeNull();
  });

  it("a denial shows the server's own reason, not a generic failure", async () => {
    runCommerceAction.mockResolvedValue({ state: "denied", reason: "amount_exceeds_refundable_maximum" });
    await openRefund();
    fireEvent.click(screen.getByTestId("refund-submit"));
    expect(await screen.findByText(/amount_exceeds_refundable_maximum/)).toBeTruthy();
  });

  it("an unavailable result is not reported as a denial", async () => {
    runCommerceAction.mockResolvedValue({ state: "unavailable", reason: "action_not_verified" });
    await openRefund();
    fireEvent.click(screen.getByTestId("refund-submit"));
    expect(await screen.findByText(/action_not_verified/)).toBeTruthy();
    expect(screen.queryByText(/commerce\.denied/)).toBeNull();
  });
});

describe("customer tags and notes", () => {
  it("shows the tags the server reported", async () => {
    renderPanel();
    expect(await screen.findByTestId("customer-tag-vip")).toBeTruthy();
  });

  it("distinguishes 'no tags' from 'could not read tags'", async () => {
    // An unreadable tag list must not render as an empty one: "this customer
    // has no tags" is a claim, and we do not have the evidence for it.
    const ctx = okContext();
    delete (ctx.data.customer as any).tags;
    fetchCommerceContext.mockResolvedValue(ctx);
    renderPanel();
    expect(await screen.findByText("commerce.tagsUnknown")).toBeTruthy();
  });

  it("adds a tag with no order id, and replaces the list from the verified result", async () => {
    runCommerceAction.mockResolvedValue({ state: "executed_customer", tags: ["vip", "wholesale"] });
    renderPanel();
    await screen.findByTestId("tag-input");
    fireEvent.change(screen.getByTestId("tag-input"), { target: { value: "wholesale" } });
    fireEvent.click(screen.getByTestId("tag-add"));

    await waitFor(() => expect(runCommerceAction).toHaveBeenCalled());
    const input = runCommerceAction.mock.calls[0][2];
    expect(input.action).toBe("add_tag");
    expect(input.params.tag).toBe("wholesale");
    // Customer-scoped actions carry no order id at all.
    expect(input.orderId).toBeUndefined();
    expect(await screen.findByTestId("customer-tag-wholesale")).toBeTruthy();
  });

  it("does not add the tag locally when the server did not return it", async () => {
    // The write reported success but the tag is absent from the verified list;
    // showing it anyway would be inventing state.
    runCommerceAction.mockResolvedValue({ state: "executed_customer", tags: ["vip"] });
    renderPanel();
    await screen.findByTestId("tag-input");
    fireEvent.change(screen.getByTestId("tag-input"), { target: { value: "wholesale" } });
    fireEvent.click(screen.getByTestId("tag-add"));
    await waitFor(() => expect(runCommerceAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("customer-tag-wholesale")).toBeNull());
  });

  it("saves a note", async () => {
    runCommerceAction.mockResolvedValue({ state: "executed_customer", noteAdded: true });
    renderPanel();
    fireEvent.click(await screen.findByTestId("note-open"));
    fireEvent.change(screen.getByTestId("note-input"), { target: { value: "Called about delay" } });
    fireEvent.click(screen.getByTestId("note-save"));
    await waitFor(() => expect(runCommerceAction).toHaveBeenCalled());
    const input = runCommerceAction.mock.calls[0][2];
    expect(input.action).toBe("add_note");
    expect(input.params.note).toBe("Called about delay");
    expect(await screen.findByText("commerce.noteAdded")).toBeTruthy();
  });

  it("will not send an empty tag or note", async () => {
    renderPanel();
    await screen.findByTestId("tag-input");
    expect((screen.getByTestId("tag-add") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("tag-input"), { target: { value: "   " } });
    expect((screen.getByTestId("tag-add") as HTMLButtonElement).disabled).toBe(true);
    expect(runCommerceAction).not.toHaveBeenCalled();
  });
});

describe("capabilities gate what is offered", () => {
  it("hides the tag and note controls when the agent may not use them", async () => {
    fetchCommerceContext.mockResolvedValue(okContext({ capabilities: caps({ canTag: false, canNote: false }) }));
    renderPanel();
    await screen.findByText("#1001");
    expect(screen.queryByTestId("customer-actions")).toBeNull();
  });

  it("keeps tags when only notes are denied", async () => {
    fetchCommerceContext.mockResolvedValue(okContext({ capabilities: caps({ canNote: false }) }));
    renderPanel();
    expect(await screen.findByTestId("tag-input")).toBeTruthy();
    expect(screen.queryByTestId("note-open")).toBeNull();
  });

  it("hides refund when the order is not refundable, even with permission", async () => {
    fetchCommerceContext.mockResolvedValue(
      okContext({ recentOrders: [order({ eligibility: { cancellable: true, refundable: false } })] }),
    );
    renderPanel();
    await screen.findByText("#1001");
    expect(screen.queryByText("commerce.refund")).toBeNull();
    expect(screen.getByText("commerce.cancel")).toBeTruthy();
  });
});
