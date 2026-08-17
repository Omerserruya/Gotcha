import { describe, it, expect } from "vitest";
import { whatsAppInboundAdapter } from "../channels/whatsapp.adapter";

/**
 * Coexistence chat-history parsing.
 *
 * Meta sends a business's past conversations once, in the minutes after
 * onboarding, and never again. Everything here is pinned because every one of
 * these failures is SILENT: the payload parses, the webhook returns 200, and
 * the customer's history is simply wrong or missing with nothing in any log to
 * say so.
 */

const BUSINESS = "972500000000";
const CUSTOMER = "972541111111";

function historyPayload(opts: {
  metaLocation: "outer" | "inner" | "both";
  phase?: number;
  chunkOrder?: number;
  progress?: number;
  messages?: any[];
}) {
  const counters = {
    phase: opts.phase ?? 0,
    chunk_order: opts.chunkOrder ?? 1,
    progress: opts.progress ?? 40,
  };
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_1",
        changes: [
          {
            field: "history",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: BUSINESS,
                phone_number_id: "PN_1",
                ...(opts.metaLocation === "outer" || opts.metaLocation === "both" ? counters : {}),
              },
              history: [
                {
                  ...(opts.metaLocation === "inner" || opts.metaLocation === "both"
                    ? { metadata: counters }
                    : {}),
                  threads: [
                    {
                      id: CUSTOMER,
                      messages: opts.messages ?? [
                        {
                          from: CUSTOMER,
                          to: BUSINESS,
                          id: "wamid.H1",
                          timestamp: "1760000000",
                          type: "text",
                          text: { body: "can I exchange after 30 days?" },
                          history_context: { status: "DELIVERED" },
                        },
                        {
                          from: BUSINESS,
                          to: CUSTOMER,
                          id: "wamid.H2",
                          timestamp: "1760000060",
                          type: "text",
                          text: { body: "yes, up to 45 days with the receipt" },
                          history_context: { status: "READ" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("the history counters are read from wherever Meta puts them", () => {
  // Meta's own reference documents phase/chunk_order/progress under
  // `value.metadata`; 360Dialog's example puts them under
  // `value.history[].metadata`. Reading only one location yields progress 0
  // forever: the import never completes, the bar never moves, and no error is
  // raised anywhere because the payload parsed perfectly.
  it.each(["outer", "inner", "both"] as const)("reads them from the %s location", (loc) => {
    const [chunk] = whatsAppInboundAdapter.extractHistorySync!(
      historyPayload({ metaLocation: loc, phase: 2, chunkOrder: 7, progress: 63 }),
    );
    expect(chunk.phase).toBe(2);
    expect(chunk.chunkOrder).toBe(7);
    expect(chunk.progress).toBe(63);
  });

  it("keeps a legitimate zero rather than falling through to a default", () => {
    // phase 0 is day 0-1, chunk 0 is the first chunk and progress 0 is a real
    // starting value. A `||` chain would discard all three.
    const [chunk] = whatsAppInboundAdapter.extractHistorySync!(
      historyPayload({ metaLocation: "inner", phase: 0, chunkOrder: 0, progress: 0 }),
    );
    expect(chunk.phase).toBe(0);
    expect(chunk.chunkOrder).toBe(0);
    expect(chunk.progress).toBe(0);
  });

  it("accepts the counters as strings, which Meta sometimes sends", () => {
    const payload = historyPayload({ metaLocation: "inner" });
    payload.entry[0].changes[0].value.history[0].metadata = {
      phase: "1",
      chunk_order: "3",
      progress: "88",
    } as any;
    const [chunk] = whatsAppInboundAdapter.extractHistorySync!(payload);
    expect(chunk).toMatchObject({ phase: 1, chunkOrder: 3, progress: 88 });
  });
});

describe("direction comes from the business number, never from assumption", () => {
  it("marks the customer's own messages inbound and the business's outbound", () => {
    const [chunk] = whatsAppInboundAdapter.extractHistorySync!(
      historyPayload({ metaLocation: "inner" }),
    );
    expect(chunk.messages).toHaveLength(2);
    expect(chunk.messages[0]).toMatchObject({
      externalMessageId: "wamid.H1",
      direction: "INBOUND",
      customerExternalId: CUSTOMER,
    });
    expect(chunk.messages[1]).toMatchObject({
      externalMessageId: "wamid.H2",
      direction: "OUTBOUND",
      // The thread key is the CUSTOMER for both directions. Keying the
      // outbound half off `from` would open a conversation with ourselves.
      customerExternalId: CUSTOMER,
    });
  });

  it("compares numbers by their digits, not their punctuation", () => {
    const payload = historyPayload({ metaLocation: "inner" });
    payload.entry[0].changes[0].value.metadata.display_phone_number = "+972 50-000-0000";
    payload.entry[0].changes[0].value.history[0].threads[0].messages[1].from = "972500000000";
    const [chunk] = whatsAppInboundAdapter.extractHistorySync!(payload);
    expect(chunk.messages[1].direction).toBe("OUTBOUND");
  });

  it("carries the source's own delivery status through for audit", () => {
    const [chunk] = whatsAppInboundAdapter.extractHistorySync!(
      historyPayload({ metaLocation: "inner" }),
    );
    expect(chunk.messages[0].sourceStatus).toBe("DELIVERED");
    expect(chunk.messages[1].sourceStatus).toBe("READ");
  });
});

describe("a business that declined is an answer, not a failure", () => {
  it("reports unavailable with Meta's own reason", () => {
    const declined = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_1",
          changes: [
            {
              field: "history",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: BUSINESS, phone_number_id: "PN_1" },
                history: [
                  {
                    errors: [
                      {
                        code: 2593109,
                        title: "History sync is turned off by the business from the WhatsApp Business App",
                        error_data: { details: "History sharing is turned off by the business" },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const [chunk] = whatsAppInboundAdapter.extractHistorySync!(declined);
    expect(chunk.unavailable).toBeTruthy();
    expect(chunk.unavailable!.code).toBe(2593109);
    expect(chunk.unavailable!.reason).toContain("turned off");
    expect(chunk.messages).toHaveLength(0);
  });

  it("does not throw, so one declined number cannot break the delivery", () => {
    expect(() =>
      whatsAppInboundAdapter.extractHistorySync!({
        object: "whatsapp_business_account",
        entry: [{ id: "W", changes: [{ field: "history", value: { metadata: { phone_number_id: "PN_1" }, history: [{ errors: [{}] }] } }] }],
      }),
    ).not.toThrow();
  });
});

describe("history never leaks into the live paths", () => {
  const payload = historyPayload({ metaLocation: "inner" });

  it("produces no inbound customer messages", () => {
    // The single most consequential property in this file. If a history
    // payload produced inbound messages, the AI would answer conversations
    // from last March.
    expect(whatsAppInboundAdapter.extractMessages(payload)).toEqual([]);
  });

  it("produces no outbound echoes", () => {
    expect(whatsAppInboundAdapter.extractOutboundEchoes!(payload)).toEqual([]);
  });

  it("produces no delivery status updates", () => {
    expect(whatsAppInboundAdapter.extractStatusUpdates(payload)).toEqual([]);
  });

  it("and the reverse: a normal message payload yields no history", () => {
    const inbound = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PN_1" },
                messages: [
                  { from: CUSTOMER, id: "wamid.IN1", timestamp: "1760000001", type: "text", text: { body: "hi" } },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(whatsAppInboundAdapter.extractHistorySync!(inbound)).toEqual([]);
  });
});

describe("the channel account resolves for history, or nothing is delivered", () => {
  it("resolves the phone number id from a history payload", () => {
    // Without `history` in the account-bearing set, the webhook drops the
    // payload at step 3 before any handler sees it, and the entire feature is
    // inert with a 200 response and no log line.
    expect(
      whatsAppInboundAdapter.resolveChannelAccountExternalId(
        historyPayload({ metaLocation: "inner" }),
      ),
    ).toBe("PN_1");
  });
});

describe("malformed history degrades instead of failing", () => {
  it("skips threads with no id and messages with no id", () => {
    const payload = historyPayload({
      metaLocation: "inner",
      messages: [
        { from: CUSTOMER, timestamp: "1760000000", type: "text", text: { body: "no id" } },
        { from: CUSTOMER, id: "wamid.OK", timestamp: "1760000000", type: "text", text: { body: "kept" } },
      ],
    });
    const [chunk] = whatsAppInboundAdapter.extractHistorySync!(payload);
    expect(chunk.messages.map((m) => m.externalMessageId)).toEqual(["wamid.OK"]);
  });

  it("survives a message with no usable timestamp", () => {
    // Losing the true date of one ancient message is a far smaller loss than
    // failing the chunk it sits in - Postgres rejects an Invalid Date outright.
    const payload = historyPayload({
      metaLocation: "inner",
      messages: [
        { from: CUSTOMER, id: "wamid.NOTS", type: "text", text: { body: "x" } },
      ],
    });
    const [chunk] = whatsAppInboundAdapter.extractHistorySync!(payload);
    expect(chunk.messages).toHaveLength(1);
    expect(Number.isNaN(chunk.messages[0].timestamp.getTime())).toBe(false);
  });

  it("returns nothing when the payload has no phone number id to key on", () => {
    const payload = historyPayload({ metaLocation: "inner" });
    delete (payload.entry[0].changes[0].value.metadata as any).phone_number_id;
    expect(whatsAppInboundAdapter.extractHistorySync!(payload)).toEqual([]);
  });

  it("reports the thread count so ingest can report progress honestly", () => {
    const [chunk] = whatsAppInboundAdapter.extractHistorySync!(
      historyPayload({ metaLocation: "inner" }),
    );
    expect(chunk.threadCount).toBe(1);
  });
});
