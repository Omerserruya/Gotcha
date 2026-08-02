import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { readProvenance, SourceProvenance } from "../SourceProvenance";

// ─── Provenance ─────────────────────────────────────────────

describe("readProvenance", () => {
  it("ignores documents with no onboarding provenance", () => {
    expect(readProvenance(null)).toBeNull();
    expect(readProvenance({})).toBeNull();
    expect(readProvenance({ some: "thing" })).toBeNull();
    expect(readProvenance([1, 2])).toBeNull();
    // Hand-written knowledge has no origin marker and must stay unbadged.
    expect(readProvenance({ topic: "faq", checksum: "abc" })).toBeNull();
  });

  it("reads the provenance the projection stamps", () => {
    const p = readProvenance({
      origin: "onboarding",
      topic: "shipping_returns",
      sourceType: "onboarding_scan",
      sourceUrl: "https://acme.com/shipping",
      normalizedUrl: "acme.com/shipping",
      checksum: "deadbeef",
      language: "he",
      createdDuringOnboarding: true,
      lastRefreshedAt: "2026-07-29T00:00:00.000Z",
      manualEdit: true,
    })!;
    expect(p.sourceType).toBe("onboarding_scan");
    expect(p.manualEdit).toBe(true);
    expect(p.normalizedUrl).toBe("acme.com/shipping");
  });
});

describe("SourceProvenance", () => {
  const META = {
    origin: "onboarding",
    topic: "business_overview",
    sourceType: "onboarding_scan",
    sourceUrl: "https://acme.com",
    normalizedUrl: "acme.com",
    checksum: "0123456789abcdef",
    language: "en",
    createdDuringOnboarding: true,
    lastRefreshedAt: new Date().toISOString(),
  };

  it("tells the customer the entry came from the website scan", () => {
    render(<SourceProvenance metadata={META} he={false} />);
    expect(screen.getByText("From website scan")).toBeTruthy();
    expect(screen.getByText("acme.com")).toBeTruthy();
  });

  it("renders nothing for knowledge a human added", () => {
    const { container } = render(<SourceProvenance metadata={{ note: "typed by hand" }} he={false} />);
    expect(container.textContent).toBe("");
  });

  it("marks an entry the customer edited, so they know a re-scan won't revert it", () => {
    render(<SourceProvenance metadata={{ ...META, manualEdit: true }} he={false} />);
    expect(screen.getByText("Edited by you")).toBeTruthy();
  });

  it("never renders internal identifiers - no checksum, no dedupe key, no tenant id", () => {
    const { container } = render(
      <SourceProvenance
        metadata={{ ...META, dedupeKey: "onboarding_scan:business_overview", tenantId: "tnt_secret_123" }}
        he={false}
      />,
    );
    const html = container.innerHTML;
    expect(html).not.toContain("0123456789abcdef");
    expect(html).not.toContain("dedupeKey");
    expect(html).not.toContain("tnt_secret_123");
  });

  it("speaks Hebrew for a Hebrew tenant", () => {
    render(<SourceProvenance metadata={META} he={true} />);
    expect(screen.getByText("מסריקת האתר")).toBeTruthy();
  });

  it("labels each source family distinctly", () => {
    for (const [type, label] of [
      ["file", "Uploaded file"],
      ["drive", "Google Drive"],
      ["readiness_answer", "You answered this"],
      ["url", "Web page"],
    ] as const) {
      const { unmount } = render(<SourceProvenance metadata={{ ...META, sourceType: type }} he={false} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });
});
