/**
 * Movement 1a, and the consent that has to happen on it.
 *
 * Setup used to skip this screen whenever a domain could be guessed from the
 * sign-up email, which meant most customers never saw it. That is fine for a
 * domain confirmation and not fine for the Terms and Privacy Policy, so the
 * screen now always renders and the scan cannot start until the box is ticked.
 *
 * The cases below are the ways that gate could quietly stop working: a button
 * that enables itself, a keyboard shortcut that bypasses the mouse path, or a
 * link that points at a page the Trust Center does not publish.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DomainScreen } from "../domain-screen";

function setup(overrides: Partial<React.ComponentProps<typeof DomainScreen>> = {}) {
  const onScan = vi.fn();
  const setDomain = vi.fn();
  const utils = render(
    <DomainScreen he={false} domain="acme.com" setDomain={setDomain} onScan={onScan} error="" {...overrides} />,
  );
  return { onScan, setDomain, ...utils };
}

const consentBox = () => screen.getByRole("checkbox");
const scanButton = () => screen.getByRole("button", { name: /investigate my business/i });

describe("the consent gate", () => {
  it("starts unticked", () => {
    setup();
    expect((consentBox() as HTMLInputElement).checked).toBe(false);
  });

  it("keeps the scan button disabled until the box is ticked", () => {
    setup();
    expect(scanButton()).toBeDisabled();

    fireEvent.click(consentBox());
    expect(scanButton()).not.toBeDisabled();
  });

  it("does not start a scan on a click while the box is unticked", () => {
    const { onScan } = setup();
    fireEvent.click(scanButton());
    expect(onScan).not.toHaveBeenCalled();
  });

  it("does not start a scan on Enter while the box is unticked", () => {
    // The keyboard path is a separate branch from the button, and it is the one
    // a gate is most likely to be added to last.
    const { onScan } = setup();
    fireEvent.keyDown(screen.getByPlaceholderText("yourbusiness.com"), { key: "Enter" });
    expect(onScan).not.toHaveBeenCalled();
  });

  it("stays disabled with consent but no domain", () => {
    setup({ domain: "   " });
    fireEvent.click(consentBox());
    expect(scanButton()).toBeDisabled();
  });

  it("reports the acceptance to the caller, so it can be recorded", () => {
    const { onScan } = setup();
    fireEvent.click(consentBox());
    fireEvent.click(scanButton());
    expect(onScan).toHaveBeenCalledWith(true);
  });

  it("reports it on the Enter path too", () => {
    const { onScan } = setup();
    fireEvent.click(consentBox());
    fireEvent.keyDown(screen.getByPlaceholderText("yourbusiness.com"), { key: "Enter" });
    expect(onScan).toHaveBeenCalledWith(true);
  });

  it("can be unticked again, and re-locks the button", () => {
    setup();
    fireEvent.click(consentBox());
    fireEvent.click(consentBox());
    expect(scanButton()).toBeDisabled();
  });
});

describe("the documents", () => {
  it("links both, at the slugs the Trust Center publishes", () => {
    setup();
    expect(screen.getByRole("link", { name: /terms of service/i })).toHaveAttribute(
      "href",
      "/legal/terms-of-service",
    );
    expect(screen.getByRole("link", { name: /privacy policy/i })).toHaveAttribute(
      "href",
      "/legal/privacy-policy",
    );
  });

  it("opens them in a new tab, so reading the terms does not cost the typed domain", () => {
    setup();
    for (const name of [/terms of service/i, /privacy policy/i]) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("target", "_blank");
    }
  });

  it("translates the consent line into Hebrew", () => {
    setup({ he: true });
    expect(screen.getByRole("link", { name: "תנאי השימוש" })).toHaveAttribute(
      "href",
      "/legal/terms-of-service",
    );
    expect(screen.getByRole("link", { name: "מדיניות הפרטיות" })).toBeTruthy();
  });
});

describe("the domain field itself", () => {
  it("shows the guessed domain already filled in, so this is a confirmation", () => {
    setup({ domain: "acme.com" });
    expect((screen.getByPlaceholderText("yourbusiness.com") as HTMLInputElement).value).toBe("acme.com");
  });

  it("still reports typing", () => {
    const { setDomain } = setup({ domain: "" });
    fireEvent.change(screen.getByPlaceholderText("yourbusiness.com"), { target: { value: "shop.co.il" } });
    expect(setDomain).toHaveBeenCalledWith("shop.co.il");
  });

  it("shows a scan error without clearing the consent state", () => {
    setup({ error: "I couldn't read that site." });
    fireEvent.click(consentBox());
    expect(screen.getByText("I couldn't read that site.")).toBeTruthy();
    expect(scanButton()).not.toBeDisabled();
  });
});
