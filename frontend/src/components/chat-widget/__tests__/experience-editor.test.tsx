/**
 * The shared experience editor.
 *
 * This is the file that decides whether the two channels genuinely share
 * one editor or merely look similar. Every section must render from a
 * plain `ux` block and write back canonical `ux.` paths - because the
 * Shopify settings page and the website widget's settings both hand it
 * their own draft and expect the same paths out.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  ExperienceSection,
  EXPERIENCE_SECTIONS,
  WelcomeSection,
  LauncherSection,
} from "../ExperienceEditor";

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({ t: (k: string) => k.split(".").pop() ?? k, locale: "en", dir: "ltr" }),
}));

const t = (k: string) => k.split(".").pop() ?? k;

function ux(overrides: Record<string, any> = {}) {
  return {
    welcome: { title: "Hi", subtitle: "Ask us", assistantName: "Bot", suggestedQuestions: ["a"], avatarUrl: null, avatarSize: 56, avatarOverlap: 30, textAlign: "center" },
    launcher: { shape: "circle", size: 48, position: "right", mobilePosition: "right", offsetBottom: 18, offsetSide: 18, backgroundColor: "#111827", iconColor: "#ffffff", shadow: 2, icon: "chat", label: "", showLabel: false, showBorder: false, showUnreadBadge: true },
    hero: { mediaType: "none", mediaUrl: null, height: 124, mobileHeight: 108, fadeStrength: 60, overlayStrength: 0 },
    proactive: { enabled: false, trigger: "time_on_page", delaySeconds: 15, mobileDelaySeconds: 25 },
    sounds: { enabled: false, pack: "subtle", volume: 40 },
    behavior: { openOnLoad: false, closeOnOutsideClick: false, rememberOpenState: true, mobileFullScreen: true },
    ...overrides,
  };
}

describe("one editor, used by both channels", () => {
  it("renders every shared section without a channel in sight", () => {
    for (const section of EXPERIENCE_SECTIONS) {
      const { unmount } = render(
        <ExperienceSection section={section} ux={ux()} patch={() => {}} t={t} />,
      );
      // Something rendered for each - no section silently missing.
      expect(document.body.textContent?.length ?? 0).toBeGreaterThan(0);
      unmount();
    }
  });

  it("writes canonical ux paths, which is what makes it shareable", () => {
    // Both callers hand it their own draft; the paths coming back are the
    // contract between them.
    const patch = vi.fn();
    render(<LauncherSection ux={ux()} patch={patch} t={t} />);

    const ranges = document.querySelectorAll('input[type="range"]');
    fireEvent.change(ranges[0], { target: { value: "60" } });

    expect(patch).toHaveBeenCalled();
    const [path] = patch.mock.calls[0];
    expect(path.startsWith("ux.")).toBe(true);
  });

  it("reads the welcome copy it is given", () => {
    render(<WelcomeSection ux={ux()} patch={() => {}} t={t} />);
    expect((screen.getByDisplayValue("Hi") as HTMLInputElement)).toBeTruthy();
    expect((screen.getByDisplayValue("Ask us") as HTMLTextAreaElement)).toBeTruthy();
  });

  it("falls back cleanly for a widget that has never been saved", () => {
    // The website widget renders this before its first save.
    expect(() => render(<WelcomeSection ux={undefined} patch={() => {}} t={t} />)).not.toThrow();
    expect(() => render(<LauncherSection ux={{}} patch={() => {}} t={t} />)).not.toThrow();
  });
});
