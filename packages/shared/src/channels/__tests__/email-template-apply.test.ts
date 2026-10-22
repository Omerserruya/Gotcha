/**
 * The channel's HTML email template is applied ONCE, where email leaves
 * (2026-10-22): the registry wraps the three email adapters, so every producer
 * (inbox, AI bot, automations, scheduled sends, broadcasts) gets it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  account: { id: "ca_1", tenantId: "t_1", tenant: { name: "Acme & Co" } } as any,
  setting: null as string | null,
  contact: { displayName: "Dana" } as any,
  reads: 0,
  throwOnRead: false,
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    channelAccount: { findUnique: vi.fn(async () => H.account) },
    contact: { findFirst: vi.fn(async () => H.contact) },
  },
}));
// No test here may reach a real provider: Gmail/Outlook go through fetch,
// SMTP through nodemailer. Both are stubbed and every call is counted.
const NET = vi.hoisted(() => ({ fetches: 0, smtp: 0 }));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: async () => { NET.smtp++; return { messageId: "m_1" }; } }) },
  createTransport: () => ({ sendMail: async () => { NET.smtp++; return { messageId: "m_1" }; } }),
}));
vi.stubGlobal("fetch", async () => {
  NET.fetches++;
  return new Response(JSON.stringify({ id: "x" }), { status: 200, headers: { "Content-Type": "application/json" } });
});

vi.mock("../../lib/durable-settings", () => ({
  readDurableSetting: vi.fn(async () => {
    H.reads++;
    if (H.throwOnRead) throw new Error("db down");
    return H.setting;
  }),
}));

import { withEmailTemplate, emailHtmlFor } from "../email-template-apply";
import { getOutboundAdapter } from "../registry";
import { whatsAppOutboundAdapter } from "../whatsapp.adapter";
import { messengerOutboundAdapter } from "../messenger.adapter";
import { slackOutboundAdapter } from "../slack.adapter";
import { webchatOutboundAdapter } from "../webchat.adapter";
import type { OutboundAdapter } from "../types";

const TEMPLATE = `<div class="brand">{{business_name}}</div><main>{{content}}</main><footer>{{agent_name}} / {{customer_name}}</footer>`;
const stored = (enabled: boolean, html = TEMPLATE) => JSON.stringify({ html, enabled, updatedAt: "t", updatedBy: "u" });

function recordingAdapter() {
  const calls: any[] = [];
  const adapter = {
    channel: "GMAIL",
    sendTextMessage: vi.fn(async (...args: any[]) => { calls.push(args); return "ext_1"; }),
  } as unknown as OutboundAdapter;
  return { adapter, calls };
}

const thread = { subject: "Re: Order 1234", inReplyTo: "<c@mail.test>", references: ["<a@mail.test>", "<c@mail.test>"], threadId: "t_9" };

beforeEach(() => {
  H.setting = null;
  H.reads = 0;
  H.throwOnRead = false;
  H.account = { id: "ca_1", tenantId: "t_1", tenant: { name: "Acme & Co" } };
  H.contact = { displayName: "Dana" };
});

describe("★ the template wraps the message, and only when it is on", () => {
  it("on: the adapter gets htmlBody NEXT TO the unchanged text, threading untouched", async () => {
    H.setting = stored(true);
    const { adapter, calls } = recordingAdapter();
    await withEmailTemplate("GMAIL", adapter).sendTextMessage({} as any, "support@acme.test", "buyer@x.test", "Hi <you>\nOn its way.", undefined, { ...thread, senderName: "Noa" });
    const [, , , text, , ctx] = calls[0];
    expect(text).toBe("Hi <you>\nOn its way.");
    expect(ctx).toMatchObject(thread);
    expect(ctx.htmlBody).toBe(
      `<div class="brand">Acme &amp; Co</div><main>Hi &lt;you&gt;<br>\nOn its way.</main><footer>Noa / Dana</footer>`,
    );
  });

  it("off, or never saved: the exact same call as before this existed", async () => {
    for (const setting of [stored(false), null]) {
      H.setting = setting;
      const { adapter, calls } = recordingAdapter();
      await withEmailTemplate("GMAIL", adapter).sendTextMessage({} as any, "s@acme.test", "b@x.test", "Hi", undefined, thread);
      expect(calls[0][5]).toBe(thread);
    }
  });

  it("no thread context (an AI reply): a new context with only the html, nothing invented", async () => {
    H.setting = stored(true);
    const { adapter, calls } = recordingAdapter();
    await withEmailTemplate("GMAIL", adapter).sendTextMessage({} as any, "s@acme.test", "b@x.test", "Hi", undefined, undefined);
    expect(Object.keys(calls[0][5]).sort()).toEqual(["htmlBody", "subject"]);
    expect(calls[0][5].subject).toBe("");
  });

  it("agent_name falls back to the business name when the producer did not say who", async () => {
    H.setting = stored(true, "{{agent_name}}|{{content}}");
    expect(await emailHtmlFor({ channel: "GMAIL", accountExternalId: "s", recipient: "b@x.test", text: "x" })).toBe("Acme &amp; Co|x");
  });
});

describe("★ applied once", () => {
  it("a context that already carries htmlBody passes straight through, the setting is never read", async () => {
    H.setting = stored(true);
    const { adapter, calls } = recordingAdapter();
    const ctx = { ...thread, htmlBody: "<p>already</p>" };
    await withEmailTemplate("GMAIL", adapter).sendTextMessage({} as any, "s", "b@x.test", "Hi", undefined, ctx);
    expect(calls[0][5]).toBe(ctx);
    expect(H.reads).toBe(0);
  });

  it("an adapter wrapped twice still renders the template once", async () => {
    H.setting = stored(true, "<x>{{content}}</x>");
    const { adapter, calls } = recordingAdapter();
    const twice = withEmailTemplate("GMAIL", withEmailTemplate("GMAIL", adapter));
    await twice.sendTextMessage({} as any, "s", "b@x.test", "Hi", undefined, thread);
    expect(calls[0][5].htmlBody).toBe("<x>Hi</x>");
    expect(H.reads).toBe(1);
  });

  it("the registry wraps exactly the three email adapters", async () => {
    H.setting = stored(true, "<x>{{content}}</x>");
    for (const ch of ["EMAIL", "GMAIL", "OUTLOOK"] as const) {
      H.reads = 0;
      const a = getOutboundAdapter(ch)!;
      // A provider failure is fine here: what matters is that the setting was consulted.
      await a.sendTextMessage({} as any, "s", "b@x.test", "Hi", undefined, thread).catch(() => null);
      expect(H.reads, ch).toBe(1);
    }
    // Every provider call above hit the stubs, never the network.
    expect(NET.fetches + NET.smtp).toBeGreaterThanOrEqual(3);
    // Every other channel is the provider's own adapter object, untouched
    // (asserted by identity, so no non-email provider is ever called here).
    expect(getOutboundAdapter("WHATSAPP")).toBe(whatsAppOutboundAdapter);
    expect(getOutboundAdapter("MESSENGER")).toBe(messengerOutboundAdapter);
    expect(getOutboundAdapter("SLACK")).toBe(slackOutboundAdapter);
    expect(getOutboundAdapter("WEBCHAT")).toBe(webchatOutboundAdapter);
  });
});

describe("never blocks a send", () => {
  it("an unreadable setting sends the plain message", async () => {
    H.throwOnRead = true;
    const { adapter, calls } = recordingAdapter();
    const r = await withEmailTemplate("GMAIL", adapter).sendTextMessage({} as any, "s", "b@x.test", "Hi", undefined, thread);
    expect(r).toBe("ext_1");
    expect(calls[0][5]).toBe(thread);
  });

  it("an unknown sending account sends the plain message", async () => {
    H.account = null;
    H.setting = stored(true);
    const { adapter, calls } = recordingAdapter();
    await withEmailTemplate("GMAIL", adapter).sendTextMessage({} as any, "s", "b@x.test", "Hi", undefined, thread);
    expect(calls[0][5]).toBe(thread);
  });
});

describe("the test send", () => {
  it("templateOverride renders even while the stored template is off", async () => {
    H.setting = stored(false);
    const html = await emailHtmlFor({
      channel: "GMAIL", accountExternalId: "s", recipient: "me@acme.test", text: "Sample",
      thread: { subject: "Test", templateOverride: "<t>{{content}} {{customer_name}}</t>", customerName: "Sample customer" },
    });
    expect(html).toBe("<t>Sample Sample customer</t>");
  });
});
