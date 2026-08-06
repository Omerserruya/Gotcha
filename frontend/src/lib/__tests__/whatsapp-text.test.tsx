/**
 * WhatsApp text in the inbox.
 *
 * A customer opened a message from WhatsApp Business itself and saw
 * "*Continue setting up your account*" with the asterisks showing, above a
 * business.facebook.com URL printed as dead text they had to copy by hand.
 * Both are formatting WhatsApp senders use constantly.
 *
 * The XSS case is not hypothetical: a message body is written by whoever
 * messages the business.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderMessageText } from "../whatsapp-text";

function show(text: string) {
  return render(<div data-testid="body">{renderMessageText(text)}</div>);
}

describe("WhatsApp formatting", () => {
  it("renders *bold* as bold, without the asterisks", () => {
    show("*Continue setting up your account*");
    const el = screen.getByText("Continue setting up your account");
    expect(el.tagName).toBe("STRONG");
    expect(screen.getByTestId("body").textContent).not.toContain("*");
  });

  it("renders _italic_, ~strike~ and ```mono```", () => {
    const { container } = show("_soft_ ~gone~ ```code```");
    expect(container.querySelector("em")?.textContent).toBe("soft");
    expect(container.querySelector("s")?.textContent).toBe("gone");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });

  it("leaves an unmatched marker alone", () => {
    // "2 * 3" is arithmetic. Eating the asterisk would corrupt the message.
    show("2 * 3 = 6");
    expect(screen.getByTestId("body").textContent).toBe("2 * 3 = 6");
  });

  it("keeps the sender's line breaks and spacing untouched", () => {
    show("line one\n\nline two");
    expect(screen.getByTestId("body").textContent).toBe("line one\n\nline two");
  });
});

describe("links", () => {
  it("makes an http(s) URL clickable and opens it safely", () => {
    show("Go to https://business.facebook.com/latest/whatsapp_manager/setup?x=1 now");
    const a = screen.getByRole("link") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe(
      "https://business.facebook.com/latest/whatsapp_manager/setup?x=1",
    );
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
  });

  it("does not swallow the words around it", () => {
    show("see https://x.test/a then stop");
    expect(screen.getByTestId("body").textContent).toBe("see https://x.test/a then stop");
  });

  it("refuses to linkify anything that is not http(s)", () => {
    // A javascript: or data: URL must stay inert text.
    show("javascript:alert(1) data:text/html,<b>x</b> ftp://h.test/f");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("links inside formatting still work", () => {
    show("*see https://x.test/a*");
    expect(screen.getByRole("link")).toBeTruthy();
    expect(document.querySelector("strong")).toBeTruthy();
  });
});

describe("hostile input", () => {
  it("never turns message text into markup", () => {
    const { container } = show('<img src=x onerror="alert(1)"><script>alert(2)</script>');
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByTestId("body").textContent).toContain("<img src=x");
  });

  it("does not execute through a formatted span either", () => {
    const { container } = show("*<script>alert(1)</script>*");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("<script>alert(1)</script>");
  });
});
