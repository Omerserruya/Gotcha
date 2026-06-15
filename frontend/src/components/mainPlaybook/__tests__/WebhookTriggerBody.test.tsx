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
  bodySchema: [],
  path: "/webhooks/abc123token",
};

const mocks = vi.hoisted(() => ({
  setWebhookTriggerMode: vi.fn(),
  setWebhookTriggerBodySchema: vi.fn(),
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
    setWebhookTriggerBodySchema: mocks.setWebhookTriggerBodySchema,
  };
});

const Body = NODE_REGISTRY.webhook_trigger.Body;

const shared = { flows: [{ id: "flow_1", name: "My Flow" }] } as any;

function renderBody() {
  return render(
    <Body data={{ workflowId: "flow_1" }} onChange={() => {}} shared={shared} />,
  );
}

describe("WebhookTriggerBody - dual target mode", () => {
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

  it("connected mode hides the flow selector and auto-anchors to the node id", async () => {
    const onChange = vi.fn();
    render(
      <Body
        data={{ workflowId: "", targetMode: "connected" }}
        onChange={onChange}
        shared={shared}
        nodeId="wh_node_1"
      />,
    );
    // No flow picker in connected mode - the user isn't forced to choose a flow.
    expect(screen.queryByText("Run this flow")).not.toBeInTheDocument();
    // The trigger auto-anchors to its own canvas node id.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ workflowId: "wh_node_1" }));
  });

  it("does not re-anchor an existing connected trigger that already has an anchor", async () => {
    const onChange = vi.fn();
    render(
      <Body
        data={{ workflowId: "flow_1", targetMode: "connected" }}
        onChange={onChange}
        shared={shared}
        nodeId="wh_node_1"
      />,
    );
    // Go-forward only: a legacy anchor (a real flow id) is left untouched.
    await waitFor(() => expect(screen.getByText(/Drag from this trigger/)).toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalledWith({ workflowId: "wh_node_1" });
  });
});

describe("webhook_trigger node validation", () => {
  const entry = NODE_REGISTRY.webhook_trigger;

  it("validates a connected-mode node with no flow picked", () => {
    expect(entry.validate!({ targetMode: "connected", workflowId: "" })).toBe("ok");
  });

  it("still requires a flow in flow mode", () => {
    expect(entry.validate!({ targetMode: "flow", workflowId: "" })).toBe("missing");
    expect(entry.validate!({ targetMode: "flow", workflowId: "flow_1" })).toBe("ok");
  });
});

describe("WebhookTriggerBody - How to use panel", () => {
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

    // curl copy - third copy button
    fireEvent.click(copyButtons[2]);
    await waitFor(() => {
      const curlArg = writeText.mock.calls
        .map((c) => c[0] as string)
        .find((s) => s.startsWith("curl -X POST"));
      expect(curlArg).toContain("x-webhook-secret: s3cr3t-value");
    });
  });
});

describe("WebhookTriggerBody - expected body fields editor", () => {
  beforeEach(() => {
    mocks.setWebhookTriggerBodySchema.mockReset();
    mocks.setWebhookTriggerBodySchema.mockImplementation((_t, _id, bodySchema) =>
      Promise.resolve({ data: { ...trigger, bodySchema } }),
    );
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
  });

  it("seeds the editor from the trigger's declared schema", async () => {
    const withSchema = { ...trigger, bodySchema: [{ key: "phone_number", type: "string" as const }] };
    const { getWebhookTrigger } = await import("@/lib/api");
    (getWebhookTrigger as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: withSchema });

    render(<Body data={{ workflowId: "flow_1" }} onChange={() => {}} shared={shared} />);

    await waitFor(() => expect(screen.getByText("Expected body fields")).toBeInTheDocument());
    const keyInput = await screen.findByDisplayValue("phone_number");
    expect(keyInput).toBeInTheDocument();
  });

  it("adds a field, and persists it (key + type) on blur", async () => {
    render(<Body data={{ workflowId: "flow_1" }} onChange={() => {}} shared={shared} />);
    await waitFor(() => expect(screen.getByText("Expected body fields")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Add field/ }));

    const keyInput = screen.getByPlaceholderText("field_name");
    fireEvent.change(keyInput, { target: { value: "name" } });
    fireEvent.blur(keyInput);

    await waitFor(() =>
      expect(mocks.setWebhookTriggerBodySchema).toHaveBeenCalledWith("test-token", "wt_1", [
        { key: "name", type: "string" },
      ]),
    );
  });

  it("persists immediately when the field type changes", async () => {
    const withSchema = { ...trigger, bodySchema: [{ key: "age", type: "string" as const }] };
    const { getWebhookTrigger } = await import("@/lib/api");
    (getWebhookTrigger as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: withSchema });

    render(<Body data={{ workflowId: "flow_1" }} onChange={() => {}} shared={shared} />);
    await waitFor(() => expect(screen.getByText("Expected body fields")).toBeInTheDocument());

    const typeSelect = screen.getByLabelText("Field type");
    fireEvent.change(typeSelect, { target: { value: "number" } });

    await waitFor(() =>
      expect(mocks.setWebhookTriggerBodySchema).toHaveBeenCalledWith("test-token", "wt_1", [
        { key: "age", type: "number" },
      ]),
    );
  });

  it("removes a field and persists the remaining set", async () => {
    const withSchema = {
      ...trigger,
      bodySchema: [
        { key: "phone_number", type: "string" as const },
        { key: "name", type: "string" as const },
      ],
    };
    const { getWebhookTrigger } = await import("@/lib/api");
    (getWebhookTrigger as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: withSchema });

    render(<Body data={{ workflowId: "flow_1" }} onChange={() => {}} shared={shared} />);
    await waitFor(() => expect(screen.getByText("Expected body fields")).toBeInTheDocument());

    const removeButtons = screen.getAllByRole("button", { name: "Remove field" });
    fireEvent.click(removeButtons[0]);

    await waitFor(() =>
      expect(mocks.setWebhookTriggerBodySchema).toHaveBeenCalledWith("test-token", "wt_1", [
        { key: "name", type: "string" },
      ]),
    );
  });
});

describe("WebhookTriggerBody - field mapper", () => {
  beforeEach(async () => {
    const { getWebhookTrigger } = await import("@/lib/api");
    (getWebhookTrigger as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        ...trigger,
        targetMode: "connected",
        bodySchema: [{ key: "phone_number", type: "string" as const }],
      },
    });
    Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
  });

  // Webhook trigger node "w1" wired to a Send Text node "n2".
  const graphShared = {
    flows: [{ id: "flow_1", name: "My Flow" }],
    nodes: [
      { id: "w1", type: "webhook_trigger", data: {} },
      { id: "n2", type: "send_message_text", data: {} },
    ],
    edges: [{ id: "e1", source: "w1", target: "n2" }],
  } as any;

  it("renders a mapper row per connected-node input in connected mode", async () => {
    render(
      <Body
        data={{ workflowId: "flow_1", targetMode: "connected" }}
        onChange={() => {}}
        shared={graphShared}
        nodeId="w1"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Map fields to the connected node")).toBeInTheDocument(),
    );
    // send_message_text exposes Recipient + Message text targets.
    expect(screen.getByLabelText("Map Recipient")).toBeInTheDocument();
    expect(screen.getByLabelText("Map Message text")).toBeInTheDocument();
    // The declared body field is offered as a source option (one per target row).
    expect(screen.getAllByRole("option", { name: "body.phone_number" }).length).toBeGreaterThan(0);
  });

  it("persists a binding onto the node's fieldMapping when a source is picked", async () => {
    const onChange = vi.fn();
    render(
      <Body
        data={{ workflowId: "flow_1", targetMode: "connected" }}
        onChange={onChange}
        shared={graphShared}
        nodeId="w1"
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Map Recipient")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Map Recipient"), {
      target: { value: "phone_number" },
    });

    expect(onChange).toHaveBeenCalledWith({
      fieldMapping: [{ source: "phone_number", target: "recipient" }],
    });
  });

  it("prompts to connect a node when the trigger has no outgoing edge", async () => {
    render(
      <Body
        data={{ workflowId: "flow_1", targetMode: "connected" }}
        onChange={() => {}}
        shared={{ ...graphShared, edges: [] }}
        nodeId="w1"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Map fields to the connected node")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Connect a node to this trigger/)).toBeInTheDocument();
  });

  it("does not show the mapper in flow mode", async () => {
    render(
      <Body
        data={{ workflowId: "flow_1", targetMode: "flow" }}
        onChange={() => {}}
        shared={graphShared}
        nodeId="w1"
      />,
    );
    await waitFor(() => expect(screen.getByText("How to use")).toBeInTheDocument());
    expect(screen.queryByText("Map fields to the connected node")).not.toBeInTheDocument();
  });
});
