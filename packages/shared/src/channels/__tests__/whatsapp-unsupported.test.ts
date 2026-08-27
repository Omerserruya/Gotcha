import { describe, it, expect, vi, beforeEach } from "vitest";
import { whatsAppInboundAdapter } from "../whatsapp.adapter";

/**
 * A message WhatsApp could not represent must still explain itself.
 *
 * Investigating a real one (2026-08-23) reached a dead end three times over:
 * the payload log truncated one field before `type`, the queue held the
 * already-normalized message, and the row's metadata was empty. Meta HAD sent
 * the reason - an `errors[]` array with a code - and the adapter dropped it.
 *
 * These tests pin that the reason survives, because the next occurrence is
 * only diagnosable if it does.
 */

const inbound = (message: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "972500000000", phone_number_id: "PNID" },
            contacts: [{ profile: { name: "מינרז קוסמטיקס" }, wa_id: "972586215000" }],
            messages: [message],
          },
        },
      ],
    },
  ],
});

describe("a message type WhatsApp cannot represent", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("keeps Meta's own errors[] rather than dropping the only explanation", () => {
    const msgs = whatsAppInboundAdapter.extractMessages(
      inbound({
        from: "972586215000",
        id: "wamid.ABC",
        timestamp: "1787472944",
        type: "unsupported",
        errors: [
          {
            code: 131051,
            title: "Message type is not currently supported",
            message: "Unsupported message type",
            error_data: { details: "Message type is not currently supported" },
          },
        ],
      }),
    );

    expect(msgs).toHaveLength(1);
    const u = msgs[0].content.unsupported;
    expect(u?.providerType).toBe("unsupported");
    expect(u?.errors[0].code).toBe(131051);
    expect(u?.errors[0].details).toBe("Message type is not currently supported");
    // The raw message is kept whole - the next unknown type may carry its
    // reason somewhere we have not thought of yet.
    expect(u?.raw).toMatchObject({ id: "wamid.ABC", type: "unsupported" });
  });

  it("still gives an agent something readable in the thread", () => {
    const msgs = whatsAppInboundAdapter.extractMessages(
      inbound({ from: "972586215000", id: "wamid.ABC", timestamp: "1787472944", type: "unsupported", errors: [] }),
    );
    expect(msgs[0].content.text).toBe("[unsupported message]");
    expect(msgs[0].content.type).toBe("text");
  });

  it("captures a type Meta adds later, with no errors array at all", () => {
    const msgs = whatsAppInboundAdapter.extractMessages(
      inbound({ from: "972586215000", id: "wamid.NEW", timestamp: "1787472944", type: "some_future_type" }),
    );
    expect(msgs[0].content.unsupported).toEqual({
      providerType: "some_future_type",
      errors: [],
      raw: expect.objectContaining({ type: "some_future_type" }),
    });
    expect(msgs[0].content.text).toBe("[some_future_type message]");
  });

  it("leaves an ordinary text message untouched - no diagnostic payload", () => {
    const msgs = whatsAppInboundAdapter.extractMessages(
      inbound({ from: "972586215000", id: "wamid.T", timestamp: "1787472944", type: "text", text: { body: "היי" } }),
    );
    expect(msgs[0].content.text).toBe("היי");
    expect(msgs[0].content.unsupported).toBeUndefined();
  });
});
