import { describe, it, expect } from "vitest";
import { whatsAppInboundAdapter } from "../channels/whatsapp.adapter";
import { messengerInboundAdapter } from "../channels/messenger.adapter";
import { instagramInboundAdapter } from "../channels/instagram.adapter";

/**
 * What survives the trip from a customer's phone into a Message row.
 *
 * Every field here is one the inbox cannot recover later. WhatsApp expires
 * media a few days after it is sent and the media id is the only handle on it,
 * so an id we fail to extract is a file gone for good - not a rendering bug
 * that can be fixed by reloading.
 */

function waPayload(msg: any) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_1",
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: "PN_1" },
          contacts: [{ profile: { name: "Dana" } }],
          messages: [{ from: "972541111111", id: "wamid.1", timestamp: "1760000000", ...msg }],
        },
      }],
    }],
  };
}

const wa = (msg: any) => whatsAppInboundAdapter.extractMessages(waPayload(msg))[0].content;

describe("WhatsApp inbound media", () => {
  it("carries the media id for a voice note", () => {
    // The regression that made voice notes unrecoverable: `audio` returned no
    // mediaUrl at all, so there was nothing to download with.
    const c = wa({ type: "audio", audio: { id: "MEDIA_A", mime_type: "audio/ogg; codecs=opus", voice: true } });

    expect(c.mediaUrl).toBe("MEDIA_A");
    expect(c.voice).toBe(true);
    expect(c.mimeType).toBe("audio/ogg; codecs=opus");
    expect(c.text).toBe("[Voice message]");
  });

  it("distinguishes an attached audio file from a voice note", () => {
    const c = wa({ type: "audio", audio: { id: "MEDIA_B", mime_type: "audio/mpeg" } });

    expect(c.mediaUrl).toBe("MEDIA_B");
    expect(c.voice).toBe(false);
    expect(c.text).toBe("[Audio message]");
  });

  it("keeps the sender's filename on a document", () => {
    // Stored media gets a UUID name, so this is the only thing that can label
    // the download. Without it the agent is offered "9f3c....pdf".
    const c = wa({
      type: "document",
      document: { id: "MEDIA_C", filename: "Invoice 2026-08.pdf", mime_type: "application/pdf" },
    });

    expect(c.mediaUrl).toBe("MEDIA_C");
    expect(c.fileName).toBe("Invoice 2026-08.pdf");
    expect(c.mimeType).toBe("application/pdf");
    // The filename beats the literal "[Document]" as the body.
    expect(c.caption).toBe("Invoice 2026-08.pdf");
  });

  it("prefers a real caption over the filename", () => {
    const c = wa({
      type: "document",
      document: { id: "MEDIA_D", filename: "scan.pdf", caption: "here is the signed copy" },
    });

    expect(c.caption).toBe("here is the signed copy");
    expect(c.fileName).toBe("scan.pdf");
  });

  it("treats a sticker as an image so it renders", () => {
    const c = wa({ type: "sticker", sticker: { id: "MEDIA_E", mime_type: "image/webp" } });

    expect(c.type).toBe("image");
    expect(c.mediaUrl).toBe("MEDIA_E");
  });

  it("still carries images and video with their mime", () => {
    expect(wa({ type: "image", image: { id: "M1", mime_type: "image/jpeg" } })).toMatchObject({
      type: "image", mediaUrl: "M1", mimeType: "image/jpeg",
    });
    expect(wa({ type: "video", video: { id: "M2", mime_type: "video/mp4" } })).toMatchObject({
      type: "video", mediaUrl: "M2", mimeType: "video/mp4",
    });
  });
});

describe("Messenger inbound media", () => {
  const mm = (attachment: any) =>
    messengerInboundAdapter.extractMessages({
      object: "page",
      entry: [{ messaging: [{ sender: { id: "psid" }, timestamp: 1760000000000, message: { mid: "m1", attachments: [attachment] } }] }],
    })[0].content;

  it("keeps the filename on a file attachment", () => {
    const c = mm({ type: "file", name: "quote.pdf", payload: { url: "https://cdn/x.pdf" } });

    expect(c).toMatchObject({ type: "document", mediaUrl: "https://cdn/x.pdf", fileName: "quote.pdf", caption: "quote.pdf" });
  });

  it("marks audio as a voice note", () => {
    expect(mm({ type: "audio", payload: { url: "https://cdn/a.mp4" } })).toMatchObject({
      type: "audio", mediaUrl: "https://cdn/a.mp4", voice: true,
    });
  });
});

describe("Instagram inbound media", () => {
  const ig = (attachment: any) =>
    instagramInboundAdapter.extractMessages({
      object: "instagram",
      entry: [{ messaging: [{ sender: { id: "igsid" }, timestamp: 1760000000000, message: { mid: "m1", attachments: [attachment] } }] }],
    })[0].content;

  it("marks audio as a voice note", () => {
    expect(ig({ type: "audio", payload: { url: "https://cdn/a.m4a" } })).toMatchObject({
      type: "audio", mediaUrl: "https://cdn/a.m4a", voice: true,
    });
  });

  it("handles a file attachment rather than printing it as text", () => {
    expect(ig({ type: "file", name: "brief.pdf", payload: { url: "https://cdn/b.pdf" } })).toMatchObject({
      type: "document", mediaUrl: "https://cdn/b.pdf", fileName: "brief.pdf",
    });
  });
});
