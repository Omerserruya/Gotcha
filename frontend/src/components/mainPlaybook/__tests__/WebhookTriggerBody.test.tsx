import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { NODE_REGISTRY } from "../node-registry";
import type { WebhookTriggerDto } from "@/lib/api";

vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ token: "test-token" }),
}));

const trigger: WebhookTriggerDto = {
  id: "wt_1",
  workflowId: "flow_1",
  token: "abc123token",
  secret: "s3cr3t-value",
  enabled: true,
  targetMode: "flow",
  path: "/webhooks/abc123token",
};

const mocks = vi.hoisted(() => ({
  setWebhookTriggerMode: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getWebhookTrigger: vi.fn(() => Promise.resolve({ data: trigger })),
    createWebhookTrigger: vi.fn(() => Promise.resolve({ data: trigger })),
    regenerateWebhookSecret: vi.fn(() => Promise.resolve({ data: trigger })),
    setWebhookTriggerEnabled: vi.fn(() => Promise.resolve({ data: trigger })),
    // Resolved value is configured lazily in beforeEach to avoid referencing
    // `trigger` inside this hoisted factory before it is initialized.
    setWebhookTriggerMode: mocks.setWebhookTriggerMode,
  };
});

const Body = NODE_REGISTRY.webhook_trigger.Body;

const shared = { flows: [{ id: "flow_1", name: "My Flow" }] } as any;

function renderBody() {
  return render(
    <Body data={{ workflowId: "flow_1" }} onChange={() => {}} shared={shared} />,
  );
}

describe("WebhookTriggerBody — dual target mode", () => {
  beforeEach(() => {
    mocks.setWebhookTriggerMode.mockClear();
    mocks.setWebhookTriggerMode.mockResolvedValue({
      data: { ...trigger, targetMode: "connected" },
    });
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
  });

  it("renders both target-mode options and defaults to flow mode", () => {
    render(<Body data={{ workflowId: "flow_1" }} onChange={() => {}} shared={shared} />);

    const flowBtn = screen.getByRole("button", { name: /Run another flow/ });
    const connectedBtn = screen.getByRole("button", { name: /Run connected nodes/ });
    expect(flowBtn).toBeInTheDocument();
    expect(connectedBtn).toBeInTheDocument();
    // Default preserves current behavior: flow mode is the pressed option.
    expect(flowBtn).toHaveAttribute("aria-pressed", "true");
    expect(connectedBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("switching to connected persists on the node config and mirrors to the backend", async () => {
    const onChange = vi.fn();
    render(<Body data={{ workflowId: "flow_1", targetMode: "flow" }} onChange={onChange} shared={shared} />);

    // Wait for the existing trigger to load so the backend mirror fires.
    await waitFor(() => expect(screen.getByText("How to use")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Run connected nodes/ }));

    // Node config updated immediately.
    expect(onChange).toHaveBeenCalledWith({ targetMode: "connected" });
    // Backend reconciled because a trigger record already exists.
    await waitFor(() =>
      expect(mocks.setWebhookTriggerMode).toHaveBeenCalledWith("test-token", "wt_1", "connected"),
    );
  });

  it("shows the connected-nodes wiring hint when in connected mode", () => {
    render(<Body data={{ workflowId: "flow_1", targetMode: "connected" }} onChange={() => {}} shared={shared} />);
    expect(screen.getByText(/Drag from this trigger/)).toBeInTheDocument();
  });
});

describe("WebhookTriggerBody — How to use panel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
    // jsdom sets window.location.origin to http://localhost:3000
  });

  it("renders the How to use section with URL, secret header, curl, and sample payload", async () => {
    renderBody();

    await waitFor(() => {
      expect(screen.getByText("How to use")).toBeInTheDocument();
    });

    // Live URL (origin + path) shown in the URL field
    const urlInput = document.querySelector(
      'input[value="http://localhost:3000/webhooks/abc123token"]',
    );
    expect(urlInput).toBeInTheDocument();

    // Secret header name surfaced
    expect(screen.getAllByText("x-webhook-secret").length).toBeGreaterThan(0);

    // curl example references the URL + header + secret
    const curl = screen.getByText(/curl -X POST/);
    expect(curl.textContent).toContain("http://localhost:3000/webhooks/abc123token");
    expect(curl.textContent).toContain("x-webhook-secret: s3cr3t-value");

    // Sample JSON payload present
    expect(screen.getByText(/"email": "jane@example.com"/)).toBeInTheDocument();
  });

  it("copy buttons write URL, secret, and curl to the clipboard", async () => {
    renderBody();
    await waitFor(() => expect(screen.getByText("How to use")).toBeInTheDocument());

    const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    const copyButtons = screen
      .getAllByRole("button")
      .filter((b) => b.textContent === "Copy");
    // URL, Secret, curl, Sample payload => at least 4 copy buttons
    expect(copyButtons.length).toBeGreaterThanOrEqual(4);

    // URL copy
    fireEvent.click(copyButtons[0]);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "http://localhost:3000/webhooks/abc123token",
      ),
    );

    // Secret copy
    fireEvent.click(copyButtons[1]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("s3cr3t-value"));

    // curl copy — third copy button
    fireEvent.click(copyButtons[2]);
    await waitFor(() => {
      const curlArg = writeText.mock.calls
        .map((c) => c[0] as string)
        .find((s) => s.startsWith("curl -X POST"));
      expect(curlArg).toContain("x-webhook-secret: s3cr3t-value");
    });
  });
});
