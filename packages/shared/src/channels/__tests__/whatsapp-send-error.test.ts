import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock axios BEFORE importing the adapter so the module picks up the mock.
vi.mock("axios", () => {
  const post = vi.fn();
  return { default: { post }, post };
});

import axios from "axios";
import { whatsAppInboundAdapter, whatsAppOutboundAdapter } from "../whatsapp.adapter";
import { ChannelSendError, describeSendError } from "../types";

const creds = { accessToken: "tok" } as any;

// A realistic Graph API OAuth failure (expired token) as axios surfaces it.
function graphError(overrides: any = {}) {
  return {
    isAxiosError: true,
    message: "Request failed with status code 401",
    response: {
      status: 401,
      headers: { "x-fb-request-id": "AbCdReqId123" },
      data: {
        error: {
          message: "Error validating access token: Session has expired.",
          type: "OAuthException",
          code: 190,
          error_subcode: 463,
          error_data: { details: "The session has been invalidated." },
          fbtrace_id: "Atrace123",
          ...overrides,
        },
      },
    },
  };
}

describe("whatsAppOutboundAdapter send error preservation", () => {
  beforeEach(() => (axios as any).post.mockReset());

  it("throws a ChannelSendError carrying the full Graph error breakdown", async () => {
    (axios as any).post.mockRejectedValueOnce(graphError());

    const err = await whatsAppOutboundAdapter
      .sendTextMessage(creds, "phoneId", "recipient", "hi")
      .then(() => null, (e) => e);

    expect(err).toBeInstanceOf(ChannelSendError);
    const p = (err as ChannelSendError).provider;
    expect(p.channel).toBe("WHATSAPP");
    expect(p.phase).toBe("send");
    expect(p.httpStatus).toBe(401);
    expect(p.code).toBe(190);
    expect(p.subcode).toBe(463);
    expect(p.type).toBe("OAuthException");
    expect(p.fbtraceId).toBe("Atrace123");
    expect(p.requestId).toBe("AbCdReqId123");
    expect(p.detail).toBe("The session has been invalidated.");
    expect(p.message).toContain("[190/463]");
    // Auth failures must NOT be flagged retryable.
    expect(p.retryable).toBe(false);
    // err.message stays human-readable for back-compat with `err?.message` logs.
    expect((err as Error).message).toBe(p.message);
  });

  it("flags rate-limit (code 130429) and 5xx as retryable", async () => {
    (axios as any).post.mockRejectedValueOnce(
      graphError({ code: 130429, error_subcode: undefined, type: "WhatsAppBusinessApiError" }),
    );
    const err1 = await whatsAppOutboundAdapter
      .sendTextMessage(creds, "p", "r", "x")
      .then(() => null, (e) => e);
    expect((err1 as ChannelSendError).provider.retryable).toBe(true);

    (axios as any).post.mockRejectedValueOnce({
      isAxiosError: true,
      message: "Request failed with status code 500",
      response: { status: 500, headers: {}, data: {} },
    });
    const err2 = await whatsAppOutboundAdapter
      .sendTextMessage(creds, "p", "r", "x")
      .then(() => null, (e) => e);
    expect((err2 as ChannelSendError).provider.retryable).toBe(true);
  });

  it("preserves a transport error (no Graph body) as a retryable structured error", async () => {
    (axios as any).post.mockRejectedValueOnce({ code: "ETIMEDOUT", message: "timeout of 0ms exceeded" });
    const err = await whatsAppOutboundAdapter
      .sendTextMessage(creds, "p", "r", "x")
      .then(() => null, (e) => e);
    const p = (err as ChannelSendError).provider;
    expect(p.retryable).toBe(true);
    expect(p.detail).toBe("ETIMEDOUT");
    expect(p.message).toContain("timeout");
  });
});

describe("extractStatusUpdates (async delivery failures)", () => {
  it("attaches a structured error to FAILED delivery webhooks", () => {
    const body = {
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  {
                    id: "wamid.X",
                    status: "failed",
                    timestamp: "1720000000",
                    errors: [
                      {
                        code: 131047,
                        title: "Re-engagement message",
                        error_data: { details: "Message failed to send because more than 24 hours have passed." },
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
    const [update] = whatsAppInboundAdapter.extractStatusUpdates(body);
    expect(update.status).toBe("failed");
    expect(update.error).toBeDefined();
    expect(update.error!.phase).toBe("delivery");
    expect(update.error!.code).toBe(131047);
    expect(update.error!.retryable).toBe(false);
    expect(update.errorMessage).toContain("[131047]");
  });
});

describe("describeSendError", () => {
  it("unwraps a ChannelSendError to its provider payload", () => {
    const original = new ChannelSendError({
      channel: "WHATSAPP",
      phase: "send",
      message: "[190] boom",
      code: 190,
      retryable: false,
      at: "2026-07-06T00:00:00.000Z",
    });
    const { errorMessage, sendError } = describeSendError(original);
    expect(errorMessage).toBe("[190] boom");
    expect(sendError.code).toBe(190);
  });

  it("normalizes a bare Error into a persistable structured shape", () => {
    const { errorMessage, sendError } = describeSendError(new Error("kaboom"), "WHATSAPP");
    expect(errorMessage).toBe("kaboom");
    expect(sendError.channel).toBe("WHATSAPP");
    expect(sendError.message).toBe("kaboom");
    expect(sendError.retryable).toBe(false);
    expect(typeof sendError.at).toBe("string");
  });
});
