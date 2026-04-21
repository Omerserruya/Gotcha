import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  connectedFrame,
  startFrame,
  mediaFrame,
  markFrame,
  stopFrame,
  twilioFrame,
  validateTwilioSignature,
} from "../ws/twilio-frames";

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

describe("connectedFrame", () => {
  it("parses a valid connected frame", () => {
    const raw = { event: "connected", protocol: "Call", version: "1.0" };
    const result = connectedFrame.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event).toBe("connected");
    }
  });
});

describe("startFrame", () => {
  it("parses a start frame with customParameters", () => {
    const raw = {
      event: "start",
      sequenceNumber: "1",
      streamSid: "MZ123",
      start: {
        streamSid: "MZ123",
        accountSid: "AC000",
        callSid: "CA999",
        tracks: ["inbound_track"],
        customParameters: {
          tenantId: "tenant-1",
          conversationId: "conv-abc",
          agentId: "agent-42",
        },
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      },
    };
    const result = startFrame.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.start.customParameters?.conversationId).toBe("conv-abc");
      expect(result.data.start.customParameters?.agentId).toBe("agent-42");
    }
  });

  it("parses a start frame without optional fields", () => {
    const raw = {
      event: "start",
      sequenceNumber: "1",
      streamSid: "MZ123",
      start: {
        streamSid: "MZ123",
        callSid: "CA999",
        tracks: [],
      },
    };
    const result = startFrame.safeParse(raw);
    expect(result.success).toBe(true);
  });
});

describe("mediaFrame", () => {
  it("parses a media frame", () => {
    const raw = {
      event: "media",
      sequenceNumber: "5",
      streamSid: "MZ123",
      media: {
        track: "inbound_track",
        chunk: "3",
        timestamp: "1000",
        payload: "AAAA",
      },
    };
    const result = mediaFrame.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.media.payload).toBe("AAAA");
    }
  });
});

describe("stopFrame", () => {
  it("parses a stop frame", () => {
    const raw = {
      event: "stop",
      sequenceNumber: "99",
      streamSid: "MZ123",
      stop: { accountSid: "AC000", callSid: "CA999" },
    };
    const result = stopFrame.safeParse(raw);
    expect(result.success).toBe(true);
  });
});

describe("markFrame", () => {
  it("parses a mark frame", () => {
    const raw = {
      event: "mark",
      sequenceNumber: "10",
      streamSid: "MZ123",
      mark: { name: "my-mark" },
    };
    const result = markFrame.safeParse(raw);
    expect(result.success).toBe(true);
  });
});

describe("twilioFrame discriminated union", () => {
  it("rejects a frame missing the event field", () => {
    const raw = { sequenceNumber: "1", streamSid: "MZ123" };
    const result = twilioFrame.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown event type", () => {
    const raw = { event: "unknown", sequenceNumber: "1", streamSid: "MZ123" };
    const result = twilioFrame.safeParse(raw);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Signature validation
// ---------------------------------------------------------------------------

describe("validateTwilioSignature", () => {
  const authToken = "test-auth-token-12345";
  const fullUrl = "https://example.com/twilio/media-stream/tenant-1";

  function computeHmac(url: string, params: Record<string, string> = {}): string {
    const sortedKeys = Object.keys(params).sort();
    const canonical = url + sortedKeys.map((k) => k + params[k]).join("");
    return crypto.createHmac("sha1", authToken).update(canonical).digest("base64");
  }

  it("returns true for a valid signature with no params", () => {
    const sig = computeHmac(fullUrl);
    expect(validateTwilioSignature(sig, fullUrl, authToken)).toBe(true);
  });

  it("returns false for a mismatched signature", () => {
    expect(validateTwilioSignature("bad-sig", fullUrl, authToken)).toBe(false);
  });

  it("returns false for undefined signature", () => {
    expect(validateTwilioSignature(undefined, fullUrl, authToken)).toBe(false);
  });

  it("returns false for wrong auth token", () => {
    const sig = computeHmac(fullUrl);
    expect(validateTwilioSignature(sig, fullUrl, "wrong-token")).toBe(false);
  });

  it("returns true with params (sorted concatenation)", () => {
    const params = { CallSid: "CA123", From: "+1234567890" };
    const sig = computeHmac(fullUrl, params);
    expect(validateTwilioSignature(sig, fullUrl, authToken, params)).toBe(true);
  });

  it("returns false when params differ", () => {
    const params = { CallSid: "CA123" };
    const sig = computeHmac(fullUrl, params);
    // Different params supplied at validation time
    expect(validateTwilioSignature(sig, fullUrl, authToken, { CallSid: "CA000" })).toBe(false);
  });
});
