/**
 * The customer-service window (B7, 2026-10-12). The rules are pure; the two
 * SQL readers were checked against the real dev Postgres (a JS double of SQL
 * proves nothing about the SQL).
 */
import { describe, it, expect } from "vitest";
import { replyWindowFor, sendAllowed, hasReplyWindow, REPLY_WINDOW_MS } from "../reply-window";

const NOW = new Date("2026-10-12T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const H = 60 * 60 * 1000;

describe("replyWindowFor", () => {
  it("WhatsApp inside 24h: free text, closing 24h after the customer's last message", () => {
    expect(replyWindowFor("WHATSAPP", ago(23 * H), NOW)).toEqual({
      channel: "WHATSAPP", open: true, mode: "free", closesAt: new Date(ago(23 * H).getTime() + REPLY_WINDOW_MS).toISOString(),
    });
  });

  it("★ WhatsApp past 24h, or never written: template only", () => {
    expect(replyWindowFor("WHATSAPP", ago(24 * H), NOW)).toEqual({ channel: "WHATSAPP", open: false, closesAt: null, mode: "template_only" });
    expect(replyWindowFor("WHATSAPP", null, NOW).mode).toBe("template_only");
  });

  it("★ Instagram and Messenger past 24h: closed", () => {
    expect(replyWindowFor("INSTAGRAM", ago(25 * H), NOW)).toMatchObject({ open: false, mode: "closed" });
    expect(replyWindowFor("MESSENGER", ago(25 * H), NOW)).toMatchObject({ open: false, mode: "closed" });
    expect(replyWindowFor("INSTAGRAM", ago(1 * H), NOW)).toMatchObject({ open: true, mode: "free" });
  });

  it("email and every other channel: no window at all", () => {
    for (const c of ["EMAIL", "GMAIL", "OUTLOOK", "WEBCHAT", "SHOPIFY_LIVE_CHAT", "VOICE", "SLACK"]) {
      expect(replyWindowFor(c, ago(300 * H), NOW), c).toEqual({ channel: c, open: true, closesAt: null, mode: "free" });
      expect(hasReplyWindow(c), c).toBe(false);
    }
  });
});

describe("sendAllowed", () => {
  const wa = (h: number) => replyWindowFor("WHATSAPP", ago(h * H), NOW);
  it("WhatsApp past 24h: a template goes, free text and media do not", () => {
    expect(sendAllowed(wa(30), "template")).toEqual({ ok: true });
    expect(sendAllowed(wa(30), "text")).toMatchObject({ ok: false, code: "TEMPLATE_REQUIRED" });
    expect(sendAllowed(wa(30), "image")).toMatchObject({ ok: false, code: "TEMPLATE_REQUIRED" });
  });
  it("WhatsApp inside 24h: anything", () => {
    expect(sendAllowed(wa(2), "text")).toEqual({ ok: true });
    expect(sendAllowed(wa(2), "template")).toEqual({ ok: true });
  });
  it("Instagram past 24h: nothing, not even a 'template'", () => {
    const ig = replyWindowFor("INSTAGRAM", ago(30 * H), NOW);
    expect(sendAllowed(ig, "text")).toMatchObject({ ok: false, code: "REPLY_WINDOW_CLOSED" });
    expect(sendAllowed(ig, "template")).toMatchObject({ ok: false, code: "REPLY_WINDOW_CLOSED" });
  });
});
