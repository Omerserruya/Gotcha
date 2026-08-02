import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  metaGraphVersion,
  metaGraphBaseUrl,
  reportMetaGraphVersion,
  META_GRAPH_VERSION_REVIEW_BY,
  __resetMetaGraphVersionCache,
} from "../meta-graph-version";

beforeEach(() => __resetMetaGraphVersionCache());
afterEach(() => vi.restoreAllMocks());

describe("one version, chosen deliberately", () => {
  it("defaults to a supported, non-brand-new version - never the expired one", () => {
    const v = metaGraphVersion({} as NodeJS.ProcessEnv);
    expect(v).toBe("v24.0");
    // v19.0 expired 2026-05-21 and was the default for WhatsApp AND Messenger.
    expect(v).not.toBe("v19.0");
    // v26.0 was two days old when this was written - not somewhere to put the
    // platform's primary customer channel.
    expect(v).not.toBe("v26.0");
  });

  it("builds the graph.facebook.com base URL from that one version", () => {
    expect(metaGraphBaseUrl(undefined, {} as any)).toBe("https://graph.facebook.com/v24.0");
  });

  it("accepts a single validated override for every Meta surface", () => {
    expect(metaGraphVersion({ META_GRAPH_VERSION: "v25.0" } as any)).toBe("v25.0");
    __resetMetaGraphVersionCache();
    expect(metaGraphBaseUrl(undefined, { META_GRAPH_VERSION: "v25.0" } as any))
      .toBe("https://graph.facebook.com/v25.0");
  });

  it("THROWS on a malformed override rather than silently using the default", () => {
    for (const bad of ["24.0", "v24", "vX.0", "latest", "v24.0.1"]) {
      __resetMetaGraphVersionCache();
      expect(() => metaGraphVersion({ META_GRAPH_VERSION: bad } as any))
        .toThrow(/not a valid Graph API version/);
    }
  });

  it("carries a review date inside the chosen version's support window", () => {
    expect(META_GRAPH_VERSION_REVIEW_BY).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // v24.0 is available until 2028-02-18.
    expect(new Date(META_GRAPH_VERSION_REVIEW_BY) < new Date("2028-02-18")).toBe(true);
  });
});

describe("legacy full-URL overrides keep working, but say so", () => {
  it("honours a legacy URL - a hard cutover would silently move a running system", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(metaGraphBaseUrl("https://graph.facebook.com/v23.0", {} as any))
      .toBe("https://graph.facebook.com/v23.0");
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("DEPRECATED");
  });

  it("calls out an override that pins an EXPIRED version", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    metaGraphBaseUrl("https://graph.facebook.com/v19.0", {} as any);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain("v19.0");
    expect(msg).toMatch(/EXPIRED/i);
  });

  it("strips a trailing slash so URL joins do not double up", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(metaGraphBaseUrl("https://graph.facebook.com/v23.0/", {} as any))
      .toBe("https://graph.facebook.com/v23.0");
  });

  it("warns once per distinct URL, not once per call", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 5; i++) metaGraphBaseUrl("https://graph.facebook.com/v22.0", {} as any);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("startup reporting", () => {
  it("announces the version so it is visible without reading adapter source", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(reportMetaGraphVersion({} as any)).toBe("v24.0");
    expect(String(log.mock.calls[0]?.[0])).toContain("version=v24.0");
  });

  it("ERRORS loudly if someone configures a known-expired version", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    reportMetaGraphVersion({ META_GRAPH_VERSION: "v19.0" } as any);
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toMatch(/EXPIRED/);
  });

  it("warns but does NOT refuse to boot on a future release", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => reportMetaGraphVersion({ META_GRAPH_VERSION: "v27.0" } as any)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
