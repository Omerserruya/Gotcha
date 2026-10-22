import { describe, it, expect } from "vitest";
import { plaintextCredentialsNotSecret } from "../encryption";
import { normalizeWebchatConfig, defaultWebchatConfig } from "../webchat-widget";

describe("plaintextCredentialsNotSecret: what encrypt-plaintext-credentials must leave alone (2026-10-22)", () => {
  const widget = { v: 2, displayName: "Mineraz", appearance: { primaryColor: "#123456" }, behaviour: {}, offline: {}, ux: {} };

  it("★ a WEBCHAT row is widget config, not a secret", () => {
    expect(plaintextCredentialsNotSecret({ table: "channel_accounts", channel: "WEBCHAT" }, widget)).toBe(true);
  });

  it("why: the widget reader takes the object raw, so an encrypted string reads back as the default config", () => {
    expect(normalizeWebchatConfig(widget).appearance).not.toEqual(defaultWebchatConfig().appearance);
    expect(normalizeWebchatConfig("A".repeat(64))).toEqual(defaultWebchatConfig());
  });

  it("any other channel's plaintext credentials are still found", () => {
    expect(plaintextCredentialsNotSecret({ table: "channel_accounts", channel: "WHATSAPP" }, { accessToken: "x" })).toBe(false);
  });

  it("★ the calendar marker { provider, accountEmail } is not a secret", () => {
    const t = { table: "tenant_integrations" } as const;
    expect(plaintextCredentialsNotSecret(t, { provider: "google_calendar", accountEmail: "a@b.c" })).toBe(true);
    expect(plaintextCredentialsNotSecret(t, { provider: "outlook_calendar", accountEmail: null })).toBe(true);
  });

  it("a marker with anything more, or a plain integration secret, is still found", () => {
    const t = { table: "tenant_integrations" } as const;
    expect(plaintextCredentialsNotSecret(t, { provider: "google_calendar", accountEmail: "a@b.c", refreshToken: "r" })).toBe(false);
    expect(plaintextCredentialsNotSecret(t, { apiKey: "k" })).toBe(false);
    expect(plaintextCredentialsNotSecret(t, {})).toBe(false);
  });
});
