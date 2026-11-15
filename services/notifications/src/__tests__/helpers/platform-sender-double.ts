/**
 * The @chatcenter/shared platform-sender functions, doubled for notifications
 * tests that mock @chatcenter/shared (the real resolver reads Postgres and
 * Redis; its own precedence is tested in packages/shared). Default: the env
 * pair, as before the console existed. Set PS.db for the console's number.
 *
 * Spread into a vi.mock factory: `...(await import("./helpers/platform-sender-double")).platformSenderDouble`.
 */
import * as templates from "@chatcenter/shared/src/whatsapp/platform-templates";

export const PS = {
  db: null as null | { externalId: string; accessToken: string; approved: Set<string>; enabled: Record<string, boolean> },
  marked: [] as unknown[],
  reset() { PS.db = null; PS.marked = []; },
};

const env = () => {
  const externalId = (process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
  const accessToken = (process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN ?? "").trim();
  return externalId && accessToken ? { externalId, accessToken, wabaId: null, source: "env" as const } : null;
};

export const platformSenderDouble = {
  ...templates,
  resolvePlatformWhatsAppSender: async () =>
    PS.db ? { externalId: PS.db.externalId, accessToken: PS.db.accessToken, wabaId: "waba_platform", source: "db" as const } : env(),
  platformTemplateSendable: async (key: string, governedBy: string | null, source: "db" | "env") => {
    if (source === "env") return { ok: true as const };
    if (governedBy && PS.db?.enabled[governedBy] !== true) return { ok: false as const, reason: "alert_disabled" as const };
    return PS.db?.approved.has(key) ? { ok: true as const } : { ok: false as const, reason: "template_not_approved" as const };
  },
  markPlatformTokenInvalid: async (err: unknown) => { PS.marked.push(err); return true; },
};
