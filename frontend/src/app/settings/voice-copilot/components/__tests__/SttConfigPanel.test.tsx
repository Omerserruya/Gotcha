import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, getAllByRole } from "@testing-library/react";
import { SttConfigPanel } from "../SttConfigPanel";

vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ token: "test-token" }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

const makeResponse = (body: unknown, ok = true) =>
  Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as Response);

describe("SttConfigPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders provider select and speaker-separation checkbox after load", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      makeResponse({ stt: { provider: "stub", language: "he-IL", interimResults: false } })
    );

    render(<SttConfigPanel />);

    // Wait for loading to finish
    await waitFor(() => {
      expect(screen.queryByText("app.loading")).not.toBeInTheDocument();
    });

    // Multiple comboboxes exist (provider + language) — use getAllByRole
    const selects = screen.getAllByRole("combobox");
    expect(selects.length).toBeGreaterThanOrEqual(2);

    // Google option is disabled (first select = provider select)
    const providerSelect = selects[0];
    const googleOption = getAllByRole(providerSelect as HTMLElement, "option", { name: "settings.voiceCopilot.stt.providerGoogle" })[0] as HTMLOptionElement;
    expect(googleOption.disabled).toBe(true);

    // Speaker-separation checkbox: present, disabled, checked
    const speakerCheckbox = document.getElementById("speakerSeparation") as HTMLInputElement;
    expect(speakerCheckbox).toBeInTheDocument();
    expect(speakerCheckbox.disabled).toBe(true);
    expect(speakerCheckbox.checked).toBe(true);
  });

  it("reflects values from GET response (language he-IL, interimResults true)", async () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      makeResponse({
        stt: {
          provider: "stub",
          language: "he-IL",
          interimResults: true,
        },
      })
    );

    render(<SttConfigPanel />);

    await waitFor(() => {
      expect(screen.queryByText("app.loading")).not.toBeInTheDocument();
    });

    // Language select (second combobox) shows he-IL
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const languageSelect = selects[1];
    expect(languageSelect.value).toBe("he-IL");

    // interimResults checkbox is checked
    const interimCheckbox = document.getElementById("interimResults") as HTMLInputElement;
    expect(interimCheckbox.checked).toBe(true);
  });
});
