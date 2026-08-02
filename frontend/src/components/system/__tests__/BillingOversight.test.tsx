/**
 * The platform billing panels, rendered.
 *
 * Until now these had only been typechecked, which proves they compile - not
 * that they say anything true when handed real data. Each of them exists to
 * tell an operator something they will act on: whether charging is possible,
 * who is about to stop being served, and which charges nobody could settle.
 * Being wrong is worse than being absent, because all three read as
 * authoritative.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CurrentRate,
  Enforcement,
  Reconciliations,
  type RatesPayload,
  type EnforcementPreview,
  type Reconciliation,
} from "../BillingOversight";

const RATE = {
  id: "r1",
  baseCurrency: "USD",
  quoteCurrency: "ILS",
  rate: "3.65000000",
  source: "MANUAL_PLATFORM_RATE",
  version: 4,
  status: "ACTIVE" as const,
  activeFrom: "2026-07-01T00:00:00.000Z",
  activeUntil: null,
  createdBy: "alice",
  approvedBy: "bob",
  approvedAt: "2026-07-01T09:00:00.000Z",
  createdAt: "2026-07-01T08:00:00.000Z",
};

describe("the current rate", () => {
  it("says charging is off when nothing is approved, in a sentence", () => {
    const payload: RatesPayload = { current: null, chargingEnabled: false, history: [], example: null };
    render(<CurrentRate data={payload} />);
    // An empty panel would read as "still loading". This has to be stated.
    expect(screen.getByText(/charging is off/i)).toBeTruthy();
    expect(screen.getByText(/Customers cannot pay/i)).toBeTruthy();
  });

  it("shows the rate with the worked example beside it", () => {
    const payload: RatesPayload = {
      current: RATE,
      chargingEnabled: true,
      history: [RATE],
      example: { commercial: "499.00 USD", charge: "1821.35 ILS" },
    };
    render(<CurrentRate data={payload} />);
    expect(screen.getByText("3.6500")).toBeTruthy();
    // "3.65" reads as nothing; the converted price reads as a decision.
    expect(screen.getByText(/1821\.35 ILS/)).toBeTruthy();
    expect(screen.getByText("bob")).toBeTruthy();
  });

  it("renders nothing rather than crashing on a null payload", () => {
    const { container } = render(<CurrentRate data={null} />);
    expect(container.textContent).toMatch(/charging is off/i);
  });
});

describe("enforcement preview", () => {
  const affected = (over: Partial<EnforcementPreview["affected"][0]> = {}) => ({
    tenantId: "t1",
    name: "Acme Ltd",
    status: "PENDING_PAYMENT",
    reason: "payment_required",
    recentConversations: 0,
    live: false,
    ...over,
  });

  it("is silent when nobody would be affected", () => {
    render(
      <Enforcement
        preview={{ mode: "off", enforcing: false, affected: [], totals: { tenants: 0, live: 0, byReason: {} } }}
      />,
    );
    expect(screen.getByText(/No organization would be refused/i)).toBeTruthy();
  });

  it("says WOULD be refused when enforcement is not on", () => {
    render(
      <Enforcement
        preview={{
          mode: "soft",
          enforcing: false,
          affected: [affected()],
          totals: { tenants: 1, live: 0, byReason: { payment_required: 1 } },
        }}
      />,
    );
    // Tense matters: this is a forecast, and reading it as a report would send
    // someone hunting for an outage that has not happened.
    expect(screen.getByText(/would be refused/i)).toBeTruthy();
  });

  it("says IS being refused when enforcement is already hard", () => {
    render(
      <Enforcement
        preview={{
          mode: "hard",
          enforcing: true,
          affected: [affected()],
          totals: { tenants: 1, live: 0, byReason: { payment_required: 1 } },
        }}
      />,
    );
    expect(screen.getByText(/being refused/i)).toBeTruthy();
  });

  it("calls out live conversations, because that is the whole decision", () => {
    render(
      <Enforcement
        preview={{
          mode: "off",
          enforcing: false,
          affected: [affected({ live: true, recentConversations: 42 })],
          totals: { tenants: 1, live: 1, byReason: { payment_required: 1 } },
        }}
      />,
    );
    expect(screen.getByText(/handling live conversations/i)).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("says so plainly when nobody is actually active", () => {
    render(
      <Enforcement
        preview={{
          mode: "off",
          enforcing: false,
          affected: [affected()],
          totals: { tenants: 1, live: 0, byReason: { payment_required: 1 } },
        }}
      />,
    );
    // The difference between a quiet config change and an outage.
    expect(screen.getByText(/None of them are currently handling conversations/i)).toBeTruthy();
  });

  it("explains the reason in words, not an enum", () => {
    render(
      <Enforcement
        preview={{
          mode: "off",
          enforcing: false,
          affected: [affected({ reason: "payment_required" })],
          totals: { tenants: 1, live: 0, byReason: { payment_required: 1 } },
        }}
      />,
    );
    expect(screen.getByText(/Plan never activated/i)).toBeTruthy();
    expect(screen.queryByText("payment_required")).toBeNull();
  });

  it("caps the table and says how many were left out", () => {
    const many = Array.from({ length: 40 }, (_, i) => affected({ tenantId: `t${i}`, name: `Org ${i}` }));
    render(
      <Enforcement
        preview={{ mode: "off", enforcing: false, affected: many, totals: { tenants: 40, live: 0, byReason: {} } }}
      />,
    );
    // Silent truncation would read as "that is all of them".
    expect(screen.getByText(/Showing the 25 most active of 40/i)).toBeTruthy();
  });
});

describe("reconciliations", () => {
  const row: Reconciliation = {
    id: "a1",
    organizationName: "Acme Ltd",
    purpose: "SUBSCRIPTION_INITIAL",
    amount: "499.00",
    currency: "USD",
    chargeAmount: "1821.35",
    chargeCurrency: "ILS",
    state: "UNKNOWN",
    failureCode: null,
    reviewReason: null,
    candidateCount: null,
    createdAt: "2026-07-20T10:00:00.000Z",
  };

  it("is absent when there is nothing to settle", () => {
    const { container } = render(<Reconciliations rows={[]} busy={false} onSweep={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("shows both figures, so the shekel amount is there to compare", () => {
    render(<Reconciliations rows={[row]} busy={false} onSweep={() => {}} />);
    expect(screen.getByText(/499\.00 USD/)).toBeTruthy();
    expect(screen.getByText(/1821\.35 ILS/)).toBeTruthy();
  });

  it("describes the state in words an operator can act on", () => {
    render(<Reconciliations rows={[row]} busy={false} onSweep={() => {}} />);
    expect(screen.getByText(/No answer from the provider/i)).toBeTruthy();
  });

  it("explains an ambiguous match by its count", () => {
    render(
      <Reconciliations
        rows={[{ ...row, state: "MANUAL_REVIEW", candidateCount: 3 }]}
        busy={false}
        onSweep={() => {}}
      />,
    );
    // "3 identical transactions" tells someone what to go and look at.
    expect(screen.getByText(/3 identical transactions/i)).toBeTruthy();
  });

  it("offers no way to mark something paid", () => {
    render(<Reconciliations rows={[row]} busy={false} onSweep={() => {}} />);
    const buttons = screen.getAllByRole("button").map((b) => b.textContent?.toLowerCase() ?? "");
    // Granting a plan on no evidence must not be one click away.
    expect(buttons.some((t) => /paid|approve|activate|settle/.test(t))).toBe(false);
    expect(buttons.some((t) => /check again/.test(t))).toBe(true);
  });
});
