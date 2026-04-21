import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { LiveMonitoringPanel } from "../LiveMonitoringPanel";

vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ token: "test-token" }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

const makeRow = (
  callSid: string,
  latencyMs: number,
  state: "active" | "ended" = "active"
) => ({
  callSid,
  conversationId: `conv-${callSid}`,
  agentId: `agent-${callSid}`,
  state,
  durationMs: 60000,
  lastTranscriptLatencyMs: latencyMs,
});

describe("LiveMonitoringPanel", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fetches on mount and renders 2 rows", async () => {
    const rows = [makeRow("CA1", 200), makeRow("CA2", 1800)];

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: rows }),
    } as Response);

    render(<LiveMonitoringPanel />);

    await waitFor(() => {
      expect(screen.getByText("CA1")).toBeInTheDocument();
      expect(screen.getByText("CA2")).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it("green dot for latency 200ms active, red dot for latency 1800ms", async () => {
    const rows = [makeRow("CA1", 200, "active"), makeRow("CA2", 1800, "active")];

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: rows }),
    } as Response);

    render(<LiveMonitoringPanel />);

    await waitFor(() => {
      expect(screen.getByText("CA1")).toBeInTheDocument();
    }, { timeout: 3000 });

    // Health dots are <span> with title={latencyMs+"ms"} and bg-* class
    const greenDot = document.querySelector('span[title="200ms"]');
    const redDot = document.querySelector('span[title="1800ms"]');

    expect(greenDot).toBeInTheDocument();
    expect(greenDot!.className).toContain("bg-green-500");

    expect(redDot).toBeInTheDocument();
    expect(redDot!.className).toContain("bg-red-500");
  });

  it("re-fetches after 5 seconds interval", async () => {
    vi.useFakeTimers();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [] }),
    } as Response);

    render(<LiveMonitoringPanel />);

    // Flush initial fetch
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const callsAfterMount = fetchSpy.mock.calls.length;
    expect(callsAfterMount).toBe(1);

    // Advance 5 seconds to trigger interval
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [] }),
    } as Response);

    const { unmount } = render(<LiveMonitoringPanel />);

    // Flush initial fetch
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const callsAfterMount = fetchSpy.mock.calls.length;

    unmount();

    // Advance timer — interval should NOT fire after unmount
    await act(async () => {
      vi.advanceTimersByTime(10000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy.mock.calls.length).toBe(callsAfterMount);
  });
});
