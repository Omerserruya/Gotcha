import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { TwilioPanel } from "../TwilioPanel";

vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ token: "test-token" }),
}));

// t() mock: returns key, but for keys with vars appends the var values so tests can assert on them
vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string>) => {
      if (vars) {
        // Append all var values after a pipe so tests can find them
        return key + "|" + Object.values(vars).join("|");
      }
      return key;
    },
  }),
}));

const configResponse = (overrides = {}) =>
  ({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        twilio: { accountSid: "", phoneNumber: "", webhookUrl: "", ...overrides },
      }),
  } as Response);

describe("TwilioPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders SID input, auth token (password), phone input, and test button", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(configResponse());

    render(<TwilioPanel />);

    await waitFor(() => {
      expect(screen.queryByText("app.loading")).not.toBeInTheDocument();
    });

    // Account SID + phone: text inputs
    const inputs = screen.getAllByRole("textbox");
    expect(inputs.length).toBeGreaterThanOrEqual(1);

    // Auth token: password input
    const passwordInput = document.querySelector('input[type="password"]');
    expect(passwordInput).toBeInTheDocument();

    // Test connection button
    const buttons = screen.getAllByRole("button");
    const testBtn = buttons.find((b) =>
      b.textContent === "settings.voiceCopilot.twilio.test"
    );
    expect(testBtn).toBeDefined();
  });

  it("shows phone validation error on blur with invalid number", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(configResponse());

    render(<TwilioPanel />);

    await waitFor(() => {
      expect(screen.queryByText("app.loading")).not.toBeInTheDocument();
    });

    const phoneInput = screen.getByPlaceholderText(
      "settings.voiceCopilot.twilio.phoneNumberPlaceholder"
    );
    fireEvent.change(phoneInput, { target: { value: "badphone" } });
    fireEvent.blur(phoneInput);

    await waitFor(() => {
      expect(
        screen.getByText("settings.voiceCopilot.errors.invalidPhone")
      ).toBeInTheDocument();
    });
  });

  it("shows success message containing friendlyName when test returns ok:true", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(configResponse())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, friendlyName: "Acme Co" }),
      } as Response);

    render(<TwilioPanel />);

    await waitFor(() => {
      expect(screen.queryByText("app.loading")).not.toBeInTheDocument();
    });

    // Find and click the test button by exact text
    const buttons = screen.getAllByRole("button");
    const testBtn = buttons.find(
      (b) => b.textContent === "settings.voiceCopilot.twilio.test"
    )!;
    fireEvent.click(testBtn);

    // t("testOk", {name:"Acme Co"}) => "settings.voiceCopilot.twilio.testOk|Acme Co"
    await waitFor(() => {
      const el = screen.getByText((content) => content.includes("Acme Co"));
      expect(el).toBeInTheDocument();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Verify the second call was the POST to test endpoint
    expect(fetchSpy.mock.calls[1][0]).toContain("twilio/test");
  });

  it("shows error message containing reason when test returns 401", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(configResponse())
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ ok: false, reason: "Unauthorized" }),
      } as Response);

    render(<TwilioPanel />);

    await waitFor(() => {
      expect(screen.queryByText("app.loading")).not.toBeInTheDocument();
    });

    const buttons = screen.getAllByRole("button");
    const testBtn = buttons.find(
      (b) => b.textContent === "settings.voiceCopilot.twilio.test"
    )!;
    fireEvent.click(testBtn);

    // t("testErr", {reason:"Unauthorized"}) => "settings.voiceCopilot.twilio.testErr|Unauthorized"
    await waitFor(() => {
      const el = screen.getByText((content) => content.includes("Unauthorized"));
      expect(el).toBeInTheDocument();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
