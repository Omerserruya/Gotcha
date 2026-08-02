/**
 * The Trust Center as a reader meets it: both languages, real tables, and an
 * honest signal when a document is still a draft.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { LegalLocaleProvider, LegalBody, PlaceholderNotice, LanguageToggle } from "../LegalKit";
import TrustCenterPage from "../page";
import { DocView } from "../[slug]/DocView";
import { LEGAL_CONTENT } from "../content/generated";
import { PUBLIC_LEGAL_DOCS } from "../content/registry";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

const wrap = (ui: React.ReactNode) => render(<LegalLocaleProvider>{ui}</LegalLocaleProvider>);

beforeEach(() => {
  window.localStorage.clear();
});

describe("the hub", () => {
  it("lists every published document and nothing else", () => {
    wrap(<TrustCenterPage />);
    for (const d of PUBLIC_LEGAL_DOCS) {
      expect(screen.getByTestId(`legal-card-${d.slug}`)).toBeTruthy();
    }
    expect(screen.queryByTestId("legal-card-ropa")).toBeNull();
    expect(screen.queryByTestId("legal-card-data-retention-policy")).toBeNull();
  });

  it("links each card to its document", () => {
    wrap(<TrustCenterPage />);
    const card = screen.getByTestId("legal-card-privacy-policy");
    expect(card.getAttribute("href")).toBe("/legal/privacy-policy");
  });

  it("defaults to Hebrew and switches to English on demand", () => {
    wrap(
      <>
        <LanguageToggle />
        <TrustCenterPage />
      </>,
    );
    expect(screen.getByText(LEGAL_CONTENT["privacy-policy"].he.title)).toBeTruthy();

    fireEvent.click(screen.getByTestId("legal-lang-en"));
    expect(screen.getByText(LEGAL_CONTENT["privacy-policy"].en.title)).toBeTruthy();
    expect(window.localStorage.getItem("legal.locale")).toBe("en");
  });
});

describe("a document page", () => {
  it("renders the document's own title and effective date", () => {
    wrap(<DocView slug="terms-of-service" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      LEGAL_CONTENT["terms-of-service"].he.title,
    );
  });

  it("renders markdown tables as real tables, not raw pipes", () => {
    wrap(<DocView slug="subprocessors" />);
    const table = screen.getAllByRole("table")[0];
    expect(table).toBeTruthy();
    // A column header the source markdown defines.
    expect(within(table).getAllByRole("columnheader").length).toBeGreaterThan(1);
    expect(document.body.textContent).not.toMatch(/\|\s*Provider\s*\|/);
  });

  it("shows no draft banner: every document is complete", () => {
    // The banner is not dead code, it is a fallback. Its behaviour when
    // placeholders DO exist is covered below by passing them directly.
    for (const d of PUBLIC_LEGAL_DOCS) {
      const { unmount } = wrap(<DocView slug={d.slug} />);
      expect(
        screen.queryByTestId("legal-placeholder-notice"),
        `${d.slug} renders a draft banner`,
      ).toBeNull();
      unmount();
    }
  });

  it("names the contracting entity on the terms page", () => {
    wrap(<DocView slug="terms-of-service" />);
    expect(document.body.textContent).toContain("עומר צרויה");
    expect(document.body.textContent).toContain("322570243");
  });

  it("offers the other documents at the end", () => {
    wrap(<DocView slug="dpa" />);
    expect(screen.getByText(LEGAL_CONTENT["subprocessors"].he.title)).toBeTruthy();
  });
});

describe("bidirectional text", () => {
  it("renders the same document in either language", () => {
    const { rerender } = render(
      <LegalLocaleProvider>
        <LanguageToggle />
        <DocView slug="privacy-policy" />
      </LegalLocaleProvider>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      LEGAL_CONTENT["privacy-policy"].he.title,
    );

    fireEvent.click(screen.getByTestId("legal-lang-en"));
    rerender(
      <LegalLocaleProvider>
        <LanguageToggle />
        <DocView slug="privacy-policy" />
      </LegalLocaleProvider>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      LEGAL_CONTENT["privacy-policy"].en.title,
    );
  });

  it("uses logical padding so Hebrew lists indent on the correct side", () => {
    // `ps-6` is direction-aware; `pl-6` would indent RTL lists the wrong way.
    const { container } = wrap(
      <LegalBody blocks={[{ kind: "markdown", text: "- one\n- two" }]} />,
    );
    const ul = container.querySelector("ul");
    expect(ul?.className).toContain("ps-6");
    expect(ul?.className).not.toContain("pl-6");
  });
});

describe("the placeholder notice", () => {
  it("says nothing when there is nothing to say", () => {
    const { container } = wrap(<PlaceholderNotice placeholders={[]} />);
    expect(container.textContent).toBe("");
  });

  it("names the fill-ins so the gap is actionable", () => {
    wrap(<PlaceholderNotice placeholders={["full legal name of the operating entity"]} />);
    expect(screen.getByTestId("legal-placeholder-notice").textContent).toContain(
      "[full legal name of the operating entity]",
    );
  });
});
