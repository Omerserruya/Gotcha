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
  canOpen: true, canCancel: true, canRefund: true, canTag: true, canNote: true, canNotify: true,
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

describe("customer summary shows only what the provider actually returned", () => {
  const withSummary = (over: Record<string, any>) => {
    const c = okContext();
    Object.assign(c.data.summary, over);
    fetchCommerceContext.mockResolvedValue(c);
  };

  it("renders the fields that are present", async () => {
    withSummary({
      name: "Dana Levi", email: "dana@example.com", phone: "+972500000000",
      averageOrderValue: { amount: "150.00", currency: "USD" },
      customerSince: "2025-01-05T00:00:00.000Z",
      defaultAddress: "12 Herzl St, Tel Aviv",
    });
    renderPanel();
    expect(await screen.findByTestId("customer-name")).toBeTruthy();
    fireEvent.click(screen.getByTestId("customer-summary-toggle"));
    expect(screen.getByTestId("cs-email").textContent).toContain("dana@example.com");
    expect(screen.getByTestId("cs-aov").textContent).toContain("150.00");
    expect(screen.getByTestId("cs-address").textContent).toContain("Herzl");
  });

  it("omits a field entirely rather than showing a blank or a zero", async () => {
    // "Average order: 0.00" is a claim about this customer's behaviour that
    // the data does not support. An absent field must stay absent.
    // One real field, so the section expands at all - then the ones Shopify
    // did not return must simply not be there.
    withSummary({ name: "Dana Levi", phone: "+972500000000" });
    renderPanel();
    await screen.findByTestId("customer-name");
    fireEvent.click(screen.getByTestId("customer-summary-toggle"));
    expect(screen.getByTestId("cs-phone")).toBeTruthy();
    expect(screen.queryByTestId("cs-email")).toBeNull();
    expect(screen.queryByTestId("cs-aov")).toBeNull();
    expect(screen.queryByTestId("cs-address")).toBeNull();
  });

  it("offers no expander when there is nothing extra to show", async () => {
    withSummary({ name: "Dana Levi" });
    const c = okContext();
    c.data.summary = { ...c.data.summary, name: "Dana Levi" } as any;
    fetchCommerceContext.mockResolvedValue(c);
    renderPanel();
    await screen.findByTestId("customer-summary");
    expect(screen.queryByTestId("customer-summary-toggle")).toBeNull();
  });
});

describe("order detail is progressive, and never invents money", () => {
  const withDetail = (detail: Record<string, any>) => {
    const c = okContext();
    (c.data.recentOrders[0] as any).detail = {
      lineItems: [], itemCount: 0, tracking: [], tags: [], refunds: [], ...detail,
    };
    fetchCommerceContext.mockResolvedValue(c);
  };

  it("stays collapsed until asked", async () => {
    withDetail({ subtotal: { amount: "90.00", currency: "USD" } });
    renderPanel();
    await screen.findByTestId("order-detail-toggle");
    expect(screen.queryByTestId("order-detail")).toBeNull();
    fireEvent.click(screen.getByTestId("order-detail-toggle"));
    expect(screen.getByTestId("od-subtotal").textContent).toContain("90.00");
  });

  it("renders line items with quantity and line total", async () => {
    withDetail({
      itemCount: 3,
      lineItems: [{ title: "Snowboard", variantTitle: "Large", quantity: 3, unitPrice: { amount: "50.00", currency: "USD" }, lineTotal: { amount: "150.00", currency: "USD" }, imageUrl: null }],
    });
    renderPanel();
    fireEvent.click(await screen.findByTestId("order-detail-toggle"));
    const line = screen.getByTestId("order-line");
    expect(line.textContent).toContain("Snowboard");
    expect(line.textContent).toContain("Large");
    expect(line.textContent).toContain("150.00");
  });

  it("omits money lines the provider did not give", async () => {
    withDetail({ subtotal: { amount: "90.00", currency: "USD" } });
    renderPanel();
    fireEvent.click(await screen.findByTestId("order-detail-toggle"));
    expect(screen.getByTestId("od-subtotal")).toBeTruthy();
    expect(screen.queryByTestId("od-tax")).toBeNull();
    expect(screen.queryByTestId("od-shipping")).toBeNull();
  });

  it("hides a zero outstanding balance, which is not news", async () => {
    withDetail({ outstanding: { amount: "0.00", currency: "USD" } });
    renderPanel();
    fireEvent.click(await screen.findByTestId("order-detail-toggle"));
    expect(screen.queryByTestId("od-outstanding")).toBeNull();
  });

  it("shows an outstanding balance that is real", async () => {
    withDetail({ outstanding: { amount: "40.00", currency: "USD" } });
    renderPanel();
    fireEvent.click(await screen.findByTestId("order-detail-toggle"));
    expect(screen.getByTestId("od-outstanding").textContent).toContain("40.00");
  });

  it("links tracking when a URL exists and copies the number", async () => {
    withDetail({ tracking: [{ number: "TRK1", url: "https://track/TRK1", company: "DHL" }] });
    renderPanel();
    fireEvent.click(await screen.findByTestId("order-detail-toggle"));
    const link = screen.getByText("TRK1") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.href).toContain("track/TRK1");
    expect(screen.getByTestId("copy-tracking")).toBeTruthy();
  });

  it("shows addresses, order tags and a cancellation reason when present", async () => {
    withDetail({
      shippingAddress: "12 Herzl St, Tel Aviv",
      tags: ["fragile", "priority"],
      cancelReason: "customer",
    });
    renderPanel();
    fireEvent.click(await screen.findByTestId("order-detail-toggle"));
    expect(screen.getByTestId("od-ship-to").textContent).toContain("Herzl");
    expect(screen.getByTestId("order-tags").textContent).toContain("fragile");
    expect(screen.getByTestId("od-cancel-reason").textContent).toContain("customer");
  });

  it("lists refund history", async () => {
    withDetail({ refunds: [{ at: "2026-07-20T00:00:00.000Z", amount: { amount: "25.00", currency: "USD" } }] });
    renderPanel();
    fireEvent.click(await screen.findByTestId("order-detail-toggle"));
    expect(screen.getByTestId("order-refunds").textContent).toContain("25.00");
  });
});

describe("timeline keeps Shopify's record apart from GOTCHA's actions (§24)", () => {
  const withTimeline = (timeline: any[]) => {
    const c = okContext();
    (c.data.recentOrders[0] as any).timeline = timeline;
    fetchCommerceContext.mockResolvedValue(c);
  };

  it("marks a GOTCHA action differently from a Shopify event", async () => {
    withTimeline([
      { key: "placed", label: "Order placed", at: "2026-07-01T00:00:00.000Z", reached: true },
      { key: "g1", label: "Approval requested (refund)", at: "2026-07-02T00:00:00.000Z", reached: true, source: "gotcha", actor: "agent" },
    ]);
    renderPanel();
    expect((await screen.findAllByTestId("timeline-shopify")).length).toBe(1);
    expect(screen.getAllByTestId("timeline-gotcha").length).toBe(1);
    // The reader can see WHO, not just what.
    expect(screen.getByTestId("timeline-gotcha").textContent).toContain("commerce.byGotcha");
  });

  it("attributes an AI-initiated action to the AI", async () => {
    withTimeline([{ key: "g1", label: "Action executed (refund)", at: "2026-07-02T00:00:00.000Z", reached: true, source: "gotcha", actor: "ai" }]);
    renderPanel();
    expect((await screen.findByTestId("timeline-gotcha")).textContent).toContain("commerce.byAi");
  });

  it("shows a failed step as failed rather than as another green tick", async () => {
    withTimeline([{ key: "g1", label: "Action failed (refund)", at: "2026-07-02T00:00:00.000Z", reached: true, source: "gotcha", failed: true }]);
    renderPanel();
    const li = await screen.findByTestId("timeline-gotcha");
    expect(li.querySelector(".text-rose-600") || li.className.includes("rose") || li.innerHTML.includes("rose")).toBeTruthy();
  });

  it("leaves a Shopify-only timeline untouched", async () => {
    withTimeline([{ key: "placed", label: "Order placed", at: "2026-07-01T00:00:00.000Z", reached: true }]);
    renderPanel();
    await screen.findByTestId("timeline-shopify");
    expect(screen.queryByTestId("timeline-gotcha")).toBeNull();
  });
});

describe("actions the provider cannot execute are not offered", () => {
  it("does not offer Resend confirmation at all", async () => {
    // Shopify has NO REST endpoint for this - the adapter's handler always
    // throws. A button for it is a button that can only ever fail.
    renderPanel();
    await screen.findByText("#1001");
    fireEvent.click(screen.getByLabelText("commerce.more"));
    expect(screen.queryByTestId("resend-confirmation")).toBeNull();
    expect(screen.queryByText(/commerce\.resendConfirmation/)).toBeNull();
  });
});

describe("the order list never pretends to be complete when it is not (§15)", () => {
  const manyOrders = (loaded: number, totalCount: number) => {
    const c = okContext();
    c.data.summary.orderCount = totalCount;
    c.data.recentOrders = Array.from({ length: loaded }, (_, i) =>
      order({ orderId: `gid://${i}`, orderNumber: `#10${String(i).padStart(2, "0")}` }),
    );
    fetchCommerceContext.mockResolvedValue(c);
  };

  it("says how many of how many are shown", async () => {
    manyOrders(25, 40);
    renderPanel();
    expect((await screen.findByTestId("orders-truncated")).textContent).toContain("25");
    expect(screen.getByTestId("orders-truncated").textContent).toContain("40");
  });

  it("asks the server for more rather than pretending it already has them", async () => {
    manyOrders(25, 40);
    renderPanel();
    fireEvent.click(await screen.findByTestId("orders-load-more"));
    await waitFor(() => expect(fetchCommerceContext).toHaveBeenCalledTimes(2));
    expect(fetchCommerceContext.mock.calls[1][2].limit).toBe(50);
  });

  it("says nothing when the whole list is already loaded", async () => {
    manyOrders(3, 3);
    renderPanel();
    await screen.findByText("#1000");
    expect(screen.queryByTestId("orders-truncated")).toBeNull();
  });
});
