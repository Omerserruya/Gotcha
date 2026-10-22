/**
 * Mail no person wrote is dropped at ingest (2026-10-14): a bounce from
 * example.com would have come back as a new conversation with mailer-daemon,
 * and the AI could answer it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { autoMailReason, parseHeaderBlock } from "../auto-mail";
import { fetchNewMessages } from "../gmail.adapter";
import { emailInboundAdapter } from "../email.adapter";
import type { ChannelCredentials } from "../types";

describe("autoMailReason", () => {
  it("★ each kind of mail nobody wrote", () => {
    expect(autoMailReason({ headers: { "Auto-Submitted": "auto-replied" } })).toBe("auto_submitted");
    expect(autoMailReason({ headers: { "auto-submitted": "auto-generated" } })).toBe("auto_submitted");
    expect(autoMailReason({ from: "Mail Delivery Subsystem <MAILER-DAEMON@googlemail.com>" })).toBe("mailer_daemon");
    expect(autoMailReason({ from: "postmaster@shop.test" })).toBe("mailer_daemon");
    expect(autoMailReason({ headers: { "Content-Type": 'multipart/report; report-type=delivery-status; boundary="x"' } })).toBe("dsn");
    expect(autoMailReason({ contentType: "multipart/report; report-type=disposition-notification" })).toBe("dsn");
    expect(autoMailReason({ headers: { Precedence: "bulk" } })).toBe("precedence");
    expect(autoMailReason({ headers: { Precedence: "auto_reply" } })).toBe("precedence");
    expect(autoMailReason({ headers: { "X-Autoreply": "yes" } })).toBe("autoreply");
    expect(autoMailReason({ headers: { "X-Autorespond": "Out of office" } })).toBe("autoreply");
  });

  it("★ a person's mail passes", () => {
    expect(autoMailReason({ headers: { "Auto-Submitted": "no", "Content-Type": "multipart/alternative" }, from: "Dana <dana@shop.test>" })).toBeNull();
    // A person whose address merely contains the word.
    expect(autoMailReason({ from: "daemon.fan@shop.test" })).toBeNull();
    expect(autoMailReason({ headers: { Precedence: "list" }, from: "dana@shop.test" })).toBeNull();
    expect(autoMailReason({})).toBeNull();
  });

  it("parses a raw header block, folded lines included", () => {
    expect(parseHeaderBlock("From: a@b.test\r\nContent-Type: multipart/report;\r\n report-type=delivery-status\r\nX-Other: 1")).toEqual({
      From: "a@b.test", "Content-Type": "multipart/report; report-type=delivery-status", "X-Other": "1",
    });
  });
});

describe("★ Gmail drops it before it becomes a message", () => {
  afterEach(() => vi.unstubAllGlobals());
  const creds = { accessToken: "at_1", fromAddress: "support@acme.test" } as unknown as ChannelCredentials;
  const msgs: Record<string, any[]> = {
    human: [{ name: "From", value: "Dana <dana@x.test>" }, { name: "Subject", value: "Order" }],
    bounce: [{ name: "From", value: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>" }, { name: "Subject", value: "Delivery Status Notification (Failure)" }],
    dsn: [{ name: "From", value: "Notifier <notify@x.test>" }, { name: "Content-Type", value: "multipart/report; report-type=delivery-status; boundary=b" }],
    ooo: [{ name: "From", value: "Ron <ron@x.test>" }, { name: "Auto-Submitted", value: "auto-replied" }],
  };

  it("only the person's mail is returned; each drop is logged with its reason", async () => {
    vi.stubGlobal("fetch", async (url: any) => {
      const u = String(url);
      if (u.includes("/history?")) {
        return new Response(JSON.stringify({ historyId: "2", history: [{ messagesAdded: Object.keys(msgs).map((id) => ({ message: { id, labelIds: ["INBOX"] } })) }] }), { status: 200 });
      }
      const id = u.split("/messages/")[1]!.split("?")[0]!;
      return new Response(JSON.stringify({ id, threadId: "t", snippet: "x", payload: { headers: msgs[id] } }), { status: 200 });
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { messages } = await fetchNewMessages(creds, "1", "support@acme.test");
    expect(messages.map((m) => m.messageId)).toEqual(["human"]);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual(expect.arrayContaining([
      "[Gmail] dropped auto-generated mail bounce: mailer_daemon",
      "[Gmail] dropped auto-generated mail dsn: dsn",
      "[Gmail] dropped auto-generated mail ooo: auto_submitted",
    ]));
    log.mockRestore();
  });
});

describe("★ the email webhook drops it", () => {
  it("by the raw headers a parse provider sends, or by the sender", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(emailInboundAdapter.extractMessages({ from: "Ron <ron@x.test>", to: "shop@acme.test", subject: "Re: hi", text: "Out of office", headers: "Auto-Submitted: auto-replied\nFrom: Ron <ron@x.test>" })).toEqual([]);
    expect(emailInboundAdapter.extractMessages({ from: "MAILER-DAEMON@acme.test", to: "shop@acme.test", subject: "Undelivered", text: "x" })).toEqual([]);
    expect(emailInboundAdapter.extractMessages({ from: "a@x.test", to: "shop@acme.test", subject: "s", text: "t", headers: { Precedence: "bulk" } })).toEqual([]);
    expect(log.mock.calls.length).toBe(3);
    log.mockRestore();
    // A person's mail still arrives.
    const ok = emailInboundAdapter.extractMessages({ from: "Dana <dana@x.test>", to: "shop@acme.test", subject: "Order", text: "Where is it?", headers: "From: Dana <dana@x.test>" });
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ senderId: "dana@x.test" });
  });
});
