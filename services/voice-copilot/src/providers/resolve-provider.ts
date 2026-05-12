/**
 * Voice provider resolution.
 *
 * Every voice request resolves a per-tenant TwilioProvider from the
 * tenant's ACTIVE `CommunicationChannel { channelType: VOICE }` row.
 * There is no env-credentialed shared fallback: when no active row
 * exists, the resolver throws `NoActiveVoiceChannelError`.
 *
 * Two resolver shapes are exported:
 *   - `createVoiceProviderResolver` — tenant-keyed lookup, used by paths
 *     where the agent's tenant is the natural anchor (token, twiml).
 *   - `createResolveProviderByChannelId` — channel-keyed lookup, used by
 *     inbound webhooks where the channel id is resolved from `To` before
 *     the provider is built.
 *
 * Both apply a small in-memory cache (60 s) keyed by channel id, so a
 * burst of webhook traffic doesn't decrypt the credential blob on every
 * request.
 */
import { prisma, decryptCredentials } from "@chatcenter/shared";
import { logger as rootLogger, type Logger } from "../lib/logger";
import { TwilioProvider } from "./twilio/twilio-provider";
import type { VoiceProvider, VoiceProviderResolver, VoiceAuthType } from "./voice-provider";

interface CacheEntry {
  provider: VoiceProvider;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const byoCache = new Map<string, CacheEntry>();

function cacheGet(channelId: string): VoiceProvider | null {
  const hit = byoCache.get(channelId);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    byoCache.delete(channelId);
    return null;
  }
  return hit.provider;
}

function cacheSet(channelId: string, provider: VoiceProvider): void {
  byoCache.set(channelId, { provider, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function __invalidateByoCache(): void {
  byoCache.clear();
}

/**
 * Thrown when a voice operation is attempted on a tenant / channel that
 * has no ACTIVE voice channel row. Callers should map this to a
 * 503/404/400 depending on context.
 */
export class NoActiveVoiceChannelError extends Error {
  readonly code = "no_active_voice_channel" as const;
  constructor(message: string) {
    super(message);
    this.name = "NoActiveVoiceChannelError";
  }
}

interface ByoChannelRow {
  id: string;
  tenantId: string;
  authType: VoiceAuthType;
  encryptedSecrets: Buffer | null;
  voiceChannel: {
    accountSid: string | null;
    apiKeySid: string | null;
    twimlAppSid: string | null;
    phoneNumbers: { e164: string; isActive: boolean }[];
  } | null;
}

function buildProviderFromRow(row: ByoChannelRow, logger: Logger): VoiceProvider | null {
  if (!row.encryptedSecrets || !row.voiceChannel) return null;
  // BYO credential shape: { authToken, apiKeySecret? }. `authToken` is used
  // for HMAC inbound-signature validation and REST client init; `apiKeySid`
  // (set on create on the VoiceChannel row) and `apiKeySecret` (set in the
  // encrypted blob) together with `twimlAppSid` are required to mint
  // browser-SDK AccessToken JWTs for outbound calls.
  let creds: {
    authToken?: string;
    apiKeySecret?: string | null;
  };
  try {
    creds = decryptCredentials(Buffer.from(row.encryptedSecrets).toString("utf8")) as typeof creds;
  } catch (err) {
    logger.error({ err, channelId: row.id }, "resolve-provider: secret decryption failed");
    return null;
  }
  const accountSid = row.voiceChannel.accountSid ?? "";
  const authToken = creds.authToken ?? "";
  if (!accountSid) return null;
  if (!authToken) return null;
  // Pick the first ACTIVE phone number as the caller id. The wizard
  // guarantees at most one ACTIVE per channel; if zero are active we
  // surface an empty caller id and let downstream methods error
  // explicitly when they need it.
  const activePhone = row.voiceChannel.phoneNumbers.find((pn) => pn.isActive);
  const apiKeySid = row.voiceChannel.apiKeySid ?? "";
  return new TwilioProvider({
    credentials: {
      accountSid,
      authToken,
      apiKeySid,
      apiKeySecret: creds.apiKeySecret ?? "",
      twimlAppSid: row.voiceChannel.twimlAppSid ?? "",
      callerId: activePhone?.e164 ?? "",
    },
    authType: row.authType,
    logger,
  });
}

async function findActiveChannelForTenant(tenantId: string): Promise<ByoChannelRow | null> {
  return (await prisma.communicationChannel.findFirst({
    where: {
      tenantId,
      channelType: "VOICE",
      status: "ACTIVE",
    },
    include: {
      voiceChannel: {
        include: {
          phoneNumbers: {
            where: { isActive: true },
            select: { e164: true, isActive: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  })) as unknown as ByoChannelRow | null;
}

async function findChannelById(channelId: string): Promise<ByoChannelRow | null> {
  return (await prisma.communicationChannel.findUnique({
    where: { id: channelId },
    include: {
      voiceChannel: {
        include: {
          phoneNumbers: {
            where: { isActive: true },
            select: { e164: true, isActive: true },
          },
        },
      },
    },
  })) as unknown as ByoChannelRow | null;
}

/**
 * Tenant-keyed resolver. Throws `NoActiveVoiceChannelError` when no
 * ACTIVE VOICE `CommunicationChannel` exists for the tenant.
 */
export function createVoiceProviderResolver(
  logger?: Logger,
): VoiceProviderResolver {
  return async (tenantId: string) => {
    const log = logger ?? rootLogger;
    if (!tenantId) {
      throw new NoActiveVoiceChannelError("tenantId is required");
    }
    let row: ByoChannelRow | null;
    try {
      row = await findActiveChannelForTenant(tenantId);
    } catch (err) {
      log.error({ err, tenantId }, "resolve-provider: tenant lookup failed");
      throw err;
    }
    if (!row) {
      throw new NoActiveVoiceChannelError(`no active voice channel for tenant ${tenantId}`);
    }
    const cached = cacheGet(row.id);
    if (cached) return cached;
    const provider = buildProviderFromRow(row, log);
    if (!provider) {
      throw new NoActiveVoiceChannelError(`voice channel ${row.id} is missing required credentials`);
    }
    cacheSet(row.id, provider);
    return provider;
  };
}

/**
 * Channel-keyed lookup. Used by inbound webhooks once a channel id has
 * been resolved (e.g. from the `To` E.164 → phone-number row lookup).
 * Throws `NoActiveVoiceChannelError` when the channel doesn't exist or
 * isn't ACTIVE.
 */
export function createResolveProviderByChannelId(
  logger?: Logger,
): (channelId: string) => Promise<VoiceProvider> {
  return async (channelId: string) => {
    const log = logger ?? rootLogger;
    if (!channelId) {
      throw new NoActiveVoiceChannelError("channelId is required");
    }
    const cached = cacheGet(channelId);
    if (cached) return cached;
    let row: ByoChannelRow | null;
    try {
      row = await findChannelById(channelId);
    } catch (err) {
      log.error({ err, channelId }, "resolve-provider: channel lookup failed");
      throw err;
    }
    if (!row || !row.encryptedSecrets || !row.voiceChannel) {
      throw new NoActiveVoiceChannelError(`voice channel ${channelId} is not configured`);
    }
    const provider = buildProviderFromRow(row, log);
    if (!provider) {
      throw new NoActiveVoiceChannelError(`voice channel ${channelId} is missing required credentials`);
    }
    cacheSet(channelId, provider);
    return provider;
  };
}
