import { Job } from "bullmq";
import axios from "axios";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { handleApprovalButtonReply } from "../services/whatsapp-approval-inbound.service";
import { prisma, createWorker, type AutomationEventJob, IncomingMessageJob, IncomingCommentJob, OutboundEchoJob, WebhookTriggerJob, HistoricalImportChunkJob, analyticsQueue, outgoingMessageQueue, publishEvent, decryptCredentials, metaGraphBaseUrl, suggestBySameName, isInboundExcluded, probeUploadsDir, describeUploadsProbe, classifyMediaFailure, reportOperationalFailure, ERROR_CODES, type MediaFailureReason, type InboundReferral } from "@chatcenter/shared";
import { safeUploadExtension } from "@chatcenter/shared/src/lib/upload-safety";
import { processCommentTrigger } from "../services/comment-trigger.service";
import { claimInboundMessage, releaseInboundClaim, findOrCreateOpenConversation } from "../services/inbound-dedupe";

const FB_API_URL = metaGraphBaseUrl(process.env.FACEBOOK_API_URL);
// Intentionally OUTSIDE central Meta versioning: graph.instagram.com
// (Instagram Login) rejects version-prefixed paths. See meta-graph-version.ts.
const IG_API_URL = process.env.INSTAGRAM_API_URL || "https://graph.instagram.com";
const WA_API_URL = metaGraphBaseUrl(process.env.WHATSAPP_API_URL);
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve(process.cwd(), "uploads");
const UPLOADS_BASE_URL = process.env.UPLOADS_BASE_URL || "/api/uploads";

// Prove at boot that media can actually be stored.
//
// This used to be a bare `fs.mkdirSync`, which succeeds against a directory
// that already exists and tells you nothing about whether you may WRITE to it.
// The uploads volume was root-owned while this process runs as `node`, so every
// attachment failed later at writeFileSync, was swallowed by the resolver's
// catch, and surfaced to the agent as "media unavailable" with no cause
// recorded anywhere. A real customer lost every image and voice note they sent.
const uploadsProbe = probeUploadsDir(UPLOADS_DIR);
if (!uploadsProbe.ok) {
  console.error(describeUploadsProbe(uploadsProbe, "incoming-worker"));
  reportOperationalFailure({
    errorCode: ERROR_CODES.media_storage_unwritable,
    domain: "media",
    service: "incoming-worker",
    context: { dir: uploadsProbe.dir, reason: uploadsProbe.reason ?? "unknown" },
  });
} else {
  console.log(describeUploadsProbe(uploadsProbe, "incoming-worker"));
}

async function fetchMetaProfile(senderId: string, accessToken: string, channel: string, pageId?: string, igLogin?: boolean): Promise<{ name: string | null; username: string | null; avatarUrl: string | null }> {
  let name: string | null = null;
  // Instagram's handle, kept apart from the name (2026-10-11): it is how the
  // customer is shown when they have no name, and it was being dropped.
  let username: string | null = null;
  let avatarUrl: string | null = null;

  // Try direct profile lookup first
  try {
    // Instagram IGSID uses "profile_pic", Messenger uses "picture.type(large)"
    const fields = channel === "INSTAGRAM"
      ? "name,username,profile_pic"
      : "first_name,last_name,name,picture.type(large)";
    // Instagram-Login accounts hold an IG-user token that only works against
    // graph.instagram.com; everything else (Messenger, legacy IG page tokens)
    // uses graph.facebook.com.
    const base = channel === "INSTAGRAM" && igLogin ? IG_API_URL : FB_API_URL;
    const res = await axios.get(`${base}/${senderId}`, {
      params: { fields, access_token: accessToken },
    });
    if (channel === "INSTAGRAM") {
      username = typeof res.data.username === "string" && res.data.username ? res.data.username : null;
      name = res.data.name || (username ? `@${username}` : null);
      avatarUrl = res.data.profile_pic || null;
    } else {
      const { first_name, last_name, name: fullName, picture } = res.data;
      if (first_name || last_name) name = [first_name, last_name].filter(Boolean).join(" ");
      else if (fullName) name = fullName;
      avatarUrl = picture?.data?.url || null;
    }
  } catch (err: any) {
    console.warn(`[PROFILE] Direct lookup failed for ${senderId}:`, err.response?.data?.error?.message || err.message);
  }

  // Fallback for Messenger: use Conversations API to get participant name
  if (!name && channel === "MESSENGER" && pageId) {
    try {
      const res = await axios.get(`${FB_API_URL}/${pageId}/conversations`, {
        params: {
          platform: "messenger",
          user_id: senderId,
          fields: "participants",
          access_token: accessToken,
        },
      });
      const participants = res.data?.data?.[0]?.participants?.data || [];
      const sender = participants.find((p: any) => p.id === senderId);
      if (sender?.name) {
        console.log(`[PROFILE] Messenger name via conversations API: ${sender.name}`);
        name = sender.name;
      }
    } catch (convErr: any) {
      console.warn(`[PROFILE] Conversations API fallback failed:`, convErr.response?.data?.error?.message || convErr.message);
    }
  }

  return { name, username, avatarUrl };
}

/**
 * Fetch WhatsApp contact profile picture via Cloud API contacts endpoint.
 * Uses POST /{phone_number_id}/contacts to retrieve profile info.
 */
/**
 * Flatten Meta's referral into the conversation's columns.
 *
 * `fromAdCampaign` is set from the presence of the referral itself, so the
 * boolean is true even when Meta sends a sparse object with only a source id -
 * "came from an ad" is answerable long before "which ad".
 */
function referralFields(referral: InboundReferral | undefined) {
  if (!referral) return {};
  return {
    fromAdCampaign: true,
    referralSourceType: referral.sourceType ?? null,
    referralSourceId: referral.sourceId ?? null,
    referralSourceUrl: referral.sourceUrl ?? null,
    referralHeadline: referral.headline ?? null,
    referralBody: referral.body ?? null,
    referralCtwaClid: referral.ctwaClid ?? null,
    referralAt: new Date(),
  };
}

async function fetchWhatsAppAvatar(phoneNumberId: string, contactWaId: string, accessToken: string): Promise<string | null> {
  try {
    const res = await axios.post(
      `${WA_API_URL}/${phoneNumberId}/contacts`,
      { blocking: "wait", contacts: [`+${contactWaId}`] },
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } },
    );
    const contact = res.data?.contacts?.[0];
    if (contact?.status === "valid" && contact?.profile?.photo) {
      return contact.profile.photo;
    }
    return null;
  } catch {
    // Profile picture not available (privacy settings) - silent fail
    return null;
  }
}

/**
 * Resolve a WhatsApp media ID to a local file URL.
 * 1. GET /{media_id} → { url } (temporary CDN URL)
 * 2. Download the file from CDN with auth header
 * 3. Save to local uploads directory
 * 4. Return local URL path
 */
export async function resolveWhatsAppMedia(
  mediaId: string,
  accessToken: string,
  messageType: string,
  // What the SENDER called the file, and what the channel said it was. Both
  // are optional because only documents carry a filename, but when they exist
  // they beat anything we can infer: `application/octet-stream` is a very
  // common content-type on the download and tells us nothing.
  opts?: { fileName?: string; mimeType?: string },
): Promise<{ localUrl: string; fileName: string; displayName: string; media: MediaFacts } | null> {
  try {
    // Step 1: Get the CDN download URL
    const metaRes = await axios.get(`${WA_API_URL}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const cdnUrl = metaRes.data?.url;
    if (!cdnUrl) return null;

    // Step 2: Download the file
    const fileRes = await axios.get(cdnUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: "arraybuffer",
    });

    // Determine file extension. Order matters: the sender's own filename is
    // the most reliable, then the MIME the channel declared, then the
    // download's content-type, then the message kind.
    const contentType = String(fileRes.headers["content-type"] ?? "");
    const senderExt = opts?.fileName ? path.extname(opts.fileName) : "";
    const declaredExt = extensionFromMimeOrEmpty(opts?.mimeType);
    // Only an allowlisted extension is ever written: the sender's name could
    // say ".html" and the file would be served as a page (2026-10-09).
    const ext = safeUploadExtension(senderExt, declaredExt, getExtensionFromMime(contentType, messageType));

    // Stored under a UUID (never the sender's name - that is attacker-supplied
    // text and this path is written straight to disk), but the sender's name
    // is carried back separately for the download link to use.
    const fileName = `${crypto.randomUUID()}${ext}`;
    const filePath = path.join(UPLOADS_DIR, fileName);

    // Step 3: Save to disk
    fs.writeFileSync(filePath, fileRes.data);

    return {
      localUrl: `${UPLOADS_BASE_URL}/${fileName}`,
      fileName,
      // No sender name: a readable one, never the stored uuid (2026-10-10).
      displayName: sanitizeDisplayName(opts?.fileName) || defaultMediaName(messageType, ext, new Date()),
      media: mediaFacts({
        declaredMime: opts?.mimeType,
        downloadedMime: contentType,
        byteSize: byteLengthOf(fileRes.data),
        senderFileName: opts?.fileName,
      }),
    };
  } catch (err: any) {
    // Which half failed matters, and the two have completely different fixes:
    // Meta expiring a media id is nothing an operator can act on, while an
    // unwritable volume is a one-line chown. Collapsing both into
    // "download_failed" is what sent a real investigation to the wrong place.
    const reason = classifyMediaFailure(err);
    if (reason !== "download_failed") {
      console.error(
        `[incoming-worker] media ${mediaId} could not be STORED (${reason}): ${err.message}`,
      );
      reportOperationalFailure({
        errorCode: ERROR_CODES.media_storage_unwritable,
        domain: "media",
        service: "incoming-worker",
        cause: err,
        context: { dir: UPLOADS_DIR, reason },
      });
    } else {
      console.error(`[incoming-worker] Failed to resolve WhatsApp media ${mediaId}:`, err.message);
    }
    lastMediaFailure = reason;
    return null;
  }
}

/**
 * What we know about an attachment, kept at `metadata.media` (2026-10-09) so
 * the inbox can say "PDF, 2.1 MB" without fetching the file. Never a provider
 * URL or token: only these three facts.
 */
export interface MediaFacts {
  mimeType: string | null;
  byteSize: number | null;
  originalName: string | null;
}

/**
 * The channel's declared MIME wins over the download's content-type, which is
 * often a generic application/octet-stream. Parameters are dropped.
 */
export function mediaFacts(input: {
  declaredMime?: string | null;
  downloadedMime?: string | null;
  byteSize?: number | null;
  senderFileName?: string | null;
}): MediaFacts {
  const baseMime = (raw?: string | null) => raw?.split(";")[0]?.trim().toLowerCase() || null;
  return {
    mimeType: baseMime(input.declaredMime) ?? baseMime(input.downloadedMime),
    byteSize: typeof input.byteSize === "number" && Number.isFinite(input.byteSize) ? input.byteSize : null,
    originalName: sanitizeDisplayName(input.senderFileName ?? undefined) || null,
  };
}

/**
 * A readable name for an attachment the sender did not name (2026-10-10):
 * "<kind>-<YYYY-MM-DD>.<ext>", e.g. "image-2026-10-10.jpg", "voice-2026-10-10.ogg".
 * The stored file keeps its uuid; this is only what people see.
 */
export function defaultMediaName(messageType: string, ext: string | null | undefined, at: Date): string {
  const kind: Record<string, string> = { image: "image", sticker: "sticker", audio: "voice", video: "video", document: "file" };
  const day = (Number.isNaN(at.getTime()) ? new Date() : at).toISOString().slice(0, 10);
  const e = typeof ext === "string" && /^\.[a-z0-9]{1,8}$/i.test(ext) ? ext.toLowerCase() : "";
  return `${kind[messageType] ?? "file"}-${day}${e}`;
}

/** The extension a MIME maps to, or "" when unknown (never ".bin"). */
function extFromMime(mime: string | null | undefined): string {
  const e = getExtensionFromMime(String(mime ?? "").split(";")[0].trim().toLowerCase(), "__none__");
  return e === ".bin" ? "" : e;
}

/** The hosts Meta serves Messenger and Instagram media from. */
const META_MEDIA_HOSTS = /(^|\.)(fbcdn\.net|fbsbx\.com|cdninstagram\.com|facebook\.com|instagram\.com)$/i;

/**
 * What Meta's CDN says about a Messenger/Instagram attachment we do not
 * download: one HEAD for its type and size (2026-10-10). Best effort and
 * bounded: https Meta hosts only, 4s, never throws.
 */
export async function headMetaMedia(url: string): Promise<{ mime: string | null; size: number | null }> {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !META_MEDIA_HOSTS.test(u.hostname)) return { mime: null, size: null };
    const r = await axios.head(url, { timeout: 4000, maxRedirects: 3, validateStatus: (s) => s >= 200 && s < 300 });
    const len = Number(r.headers["content-length"]);
    return { mime: (r.headers["content-type"] as string) || null, size: Number.isFinite(len) && len >= 0 ? len : null };
  } catch {
    return { mime: null, size: null };
  }
}

function byteLengthOf(data: unknown): number | null {
  if (data && typeof (data as { byteLength?: unknown }).byteLength === "number") {
    return (data as { byteLength: number }).byteLength;
  }
  return typeof data === "string" ? Buffer.byteLength(data) : null;
}

/**
 * Why the most recent media resolution failed.
 *
 * A module-level value rather than a return type, deliberately: the resolver is
 * called from two services and returns `null` on failure in both, and widening
 * that contract would mean touching every caller to carry a reason most of them
 * do nothing with. The one caller that DOES care reads it immediately after the
 * call, on the same tick.
 */
let lastMediaFailure: MediaFailureReason = "download_failed";

export function takeLastMediaFailure(): MediaFailureReason {
  const reason = lastMediaFailure;
  lastMediaFailure = "download_failed";
  return reason;
}

/**
 * The sender's filename, made safe to render and to put in a download
 * attribute. It never touches the filesystem - the stored name is always a
 * UUID - so this only has to defend the UI: strip path separators so nothing
 * reads as a directory, drop control characters, and cap the length.
 */
function sanitizeDisplayName(name?: string): string {
  if (!name) return "";
  return name
    .replace(/[\\/]/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180);
}

/**
 * Extension for a declared MIME type, or "" when we have no opinion. Distinct
 * from `getExtensionFromMime`, which always answers (falling back to ".bin")
 * and so can never be used as one link in a preference chain.
 */
function extensionFromMimeOrEmpty(mimeType?: string): string {
  const mime = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (!mime) return "";
  const ext = getExtensionFromMime(mime, "__none__");
  return ext === ".bin" ? "" : ext;
}

function getExtensionFromMime(contentType: string, messageType: string): string {
  const mimeMap: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
    "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/aac": ".aac",
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/zip": ".zip",
  };
  if (mimeMap[contentType]) return mimeMap[contentType];
  // Fallback based on message type
  switch (messageType) {
    case "image": return ".jpg";
    // WhatsApp stickers are always webp (2026-10-09).
    case "sticker": return ".webp";
    case "video": return ".mp4";
    case "audio": return ".ogg";
    case "document": return ".pdf";
    default: return ".bin";
  }
}

async function processIncomingMessage(job: Job<IncomingMessageJob>): Promise<void> {
  const { tenantId, channel, channelAccountId, normalizedMessage } = job.data;

  // Block message processing for non-active tenants
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true },
  });
  if (!tenant || tenant.status !== "ACTIVE") {
    console.log(`[incoming-worker] Skipping message for non-active tenant ${tenantId} (status: ${tenant?.status})`);
    return;
  }

  const {
    externalMessageId,
    senderId,
    senderDisplayName,
    body,
    messageType,
    interactiveReply,
    replyToExternalId,
    mediaUrl: rawMediaUrl,
    fileName: senderFileName,
    mimeType: senderMimeType,
    metadata: producerMetadata,
    referral,
  } = normalizedMessage;

  // Idempotency check
  const existing = await prisma.message.findFirst({
    where: { externalMessageId },
  });
  if (existing) return;

  // Numbers the owner keeps on their own phone. Checked BEFORE any Contact,
  // Conversation or Message row exists, because that is the only point where
  // dropping the message actually means anything - one step later and the
  // thread is created, an agent is notified, and a bot may already have
  // answered a conversation that was never meant to reach the team.
  //
  // Coexistence is why this exists: a number live in both the Business app and
  // the Cloud API delivers EVERYTHING to us, private threads included.
  if (await isInboundExcluded({ tenantId, channel, customerExternalId: senderId, channelAccountId })) {
    console.log(`[incoming-worker] dropping message from excluded sender on ${channel} (tenant ${tenantId})`);
    return;
  }

  // A manager tapping Approve/Reject on WhatsApp is NOT a customer message.
  // Intercept before any contact/conversation is created - otherwise a staff
  // phone number becomes a customer and gets handed to the bot.
  if (interactiveReply?.payload) {
    const approval = await handleApprovalButtonReply(interactiveReply.payload, senderId);
    if (approval.handled) return;
  }

  // Find or create conversation using channel-aware lookup.
  // A closed conversation stays closed - the next inbound from the same
  // customer starts a brand-new conversation. Reopening leaks stale state
  // (assignment, handoff, chatbot flow, escalation clock) and causes the
  // customer to hit whatever the previous session's terminal state was
  // instead of being routed fresh.
  let conversation = await prisma.conversation.findFirst({
    where: {
      tenantId,
      channel,
      customerExternalId: senderId,
      status: { not: "CLOSED" },
    },
    orderBy: { createdAt: "desc" },
  });

  // Fall back to the saved Contact's display name + avatar so replies don't
  // surface as raw phone numbers when the channel webhook omits the profile.
  // Use the resolver so merged-away contacts route to their surviving
  // target (personId) instead of presenting as a fresh row. Without this,
  // a merged WhatsApp contact would miss the direct lookup and downstream
  // code would see null, losing displayName/avatar continuity.
  //
  // GET-or-create, not a second lookup. This was a read, and the read is still
  // the first thing it does - `ensureContactForInbound` calls the same resolver
  // and only creates when it returns null, so merged-away senders still route
  // to their surviving target and never produce a new row.
  //
  // The customer never had to type an identifier for us to have one: the
  // channel they are talking through IS a contact method. Before this, contacts
  // existed only for senders who happened to type an email or phone into the
  // message body - 89 conversations, 2 contacts.
  //
  // Safe here specifically because both of the things that must NOT become
  // customers are already intercepted ABOVE this line: excluded senders return
  // early, and an approval button reply is handled under a comment reading
  // "before any contact/conversation is created - otherwise a staff phone
  // number becomes a customer and gets handed to the bot".
  const { ensureContactForInbound } = await import("../services/ensure-contact.service");
  const savedContact = await ensureContactForInbound({
    tenantId,
    channel,
    externalId: senderId,
    displayName: senderDisplayName,
  });

  // For Messenger/Instagram, fetch display name + avatar from Graph API if not provided
  let displayName = senderDisplayName || savedContact?.displayName || null;
  let avatarUrl: string | null = savedContact?.avatarUrl || null;
  let profileUsername: string | null = null;
  if ((!displayName || !conversation?.customerAvatarUrl) && (channel === "MESSENGER" || channel === "INSTAGRAM") && channelAccountId) {
    const channelAccount = await prisma.channelAccount.findUnique({ where: { id: channelAccountId } });
    const creds = channelAccount?.credentials;
    const decrypted = typeof creds === "string" ? decryptCredentials(creds) : (creds as any);
    const accessToken = decrypted?.accessToken;
    const pageId = decrypted?.pageId || channelAccount?.externalId;
    if (accessToken) {
      const profile = await fetchMetaProfile(senderId, accessToken, channel, pageId, decrypted?.igLogin);
      if (!displayName) displayName = profile.name;
      avatarUrl = profile.avatarUrl;
      profileUsername = profile.username;
    }
  }

  // For WhatsApp, try fetching profile picture
  if (!conversation?.customerAvatarUrl && channel === "WHATSAPP" && channelAccountId) {
    try {
      const channelAccount = await prisma.channelAccount.findUnique({ where: { id: channelAccountId } });
      const creds = channelAccount?.credentials;
      const decrypted = typeof creds === "string" ? decryptCredentials(creds) : (creds as any);
      const accessToken = decrypted?.accessToken;
      const phoneNumberId = channelAccount?.externalId;
      if (accessToken && phoneNumberId) {
        avatarUrl = await fetchWhatsAppAvatar(phoneNumberId, senderId, accessToken);
      }
    } catch { /* silent */ }
  }

  if (!conversation) {
    // Race-safe: a concurrent message from the same customer may have created
    // it since the read above; then that one is used (services/inbound-dedupe.ts).
    ({ conversation } = await findOrCreateOpenConversation<NonNullable<typeof conversation>>({
      tenantId,
      channel,
      customerExternalId: senderId,
      create: {
        tenantId,
        channel,
        channelAccountId: channelAccountId || undefined,
        customerExternalId: senderId,
        customerName: displayName,
        customerAvatarUrl: avatarUrl || undefined,
        status: "OPEN",
        ...referralFields(referral),
      },
    }));
  } else {
    const updates: any = {};
    if (displayName && !conversation.customerName) updates.customerName = displayName;
    if (avatarUrl && !conversation.customerAvatarUrl) updates.customerAvatarUrl = avatarUrl;
    // A referral on an EXISTING conversation means the customer came back
    // through a (possibly different) ad. The newest one wins: "which ad
    // brought them here" is a question about the current visit.
    if (referral) Object.assign(updates, referralFields(referral));
    if (Object.keys(updates).length > 0) {
      await prisma.conversation.update({ where: { id: conversation.id }, data: updates });
    }
  }

  // Also update Contact avatarUrl if we got one. Target the resolved
  // contact's id so a merged-away row doesn't receive the write (and so
  // avatars keep updating on the surviving target).
  //
  // The name too (2026-10-11): Instagram and Messenger send no name with the
  // message, so the contact was created nameless and the profile's name only
  // ever reached the conversation; the Customers list showed the raw IGSID.
  // Written only while the contact has none, so a name set by hand stays, and
  // the Instagram handle is kept beside it.
  if (savedContact) {
    const data: Record<string, unknown> = {};
    if (avatarUrl && !savedContact.avatarUrl) data.avatarUrl = avatarUrl;
    if (displayName && !savedContact.displayName) data.displayName = displayName;
    const meta = (savedContact.metadata && typeof savedContact.metadata === "object" ? savedContact.metadata : {}) as Record<string, unknown>;
    if (profileUsername && meta.instagramUsername !== profileUsername) data.metadata = { ...meta, instagramUsername: profileUsername };
    if (Object.keys(data).length > 0) {
      await prisma.contact.update({ where: { id: savedContact.id }, data });
    }
    // A contact that just got its first name may be someone already known on
    // another channel: suggested to a person, never linked on a name alone
    // (shared lib/identity-links). Best-effort.
    if (typeof data.displayName === "string") {
      await suggestBySameName({ tenantId, contactId: savedContact.id, displayName: data.displayName, channel })
        .catch((err) => console.warn("[incoming-worker] same-name suggestion failed:", (err as Error)?.message));
    }
  }

  // Resolve media URL (download WhatsApp media, pass through Messenger/Instagram URLs)
  let resolvedMediaUrl: string | undefined;
  let resolvedFileName: string | undefined;
  // Set when the attachment was announced but could not be fetched. Persisted
  // on the message so the inbox can say the file did not arrive, instead of
  // rendering a bare "[Document]" that looks like the customer sent the word.
  let mediaError: string | undefined;
  // metadata.media (2026-10-09). On a failed download it still records what
  // was declared, so the inbox can name the file that did not arrive.
  let media: MediaFacts | undefined;
  if (rawMediaUrl) {
    if (channel === "WHATSAPP") {
      // WhatsApp gives us a media ID, not a URL - resolve and download it
      const channelAccount = await prisma.channelAccount.findUnique({ where: { id: channelAccountId } });
      const creds = channelAccount?.credentials;
      const decrypted = typeof creds === "string" ? decryptCredentials(creds) : (creds as any);
      if (decrypted?.accessToken) {
        const resolved = await resolveWhatsAppMedia(rawMediaUrl, decrypted.accessToken, messageType, {
          fileName: senderFileName,
          mimeType: senderMimeType,
        });
        if (resolved) {
          resolvedMediaUrl = resolved.localUrl;
          // The name the AGENT sees. The file on disk keeps its UUID.
          resolvedFileName = resolved.displayName;
          media = resolved.media;
        } else {
          // Meta expires media after a few days and the id is the only handle
          // on it, so a download failure here is permanent for that file. A
          // STORAGE failure is not permanent at all - it is an operator fix -
          // and the two must not be recorded as the same thing.
          mediaError = takeLastMediaFailure();
          console.warn(`[incoming-worker] media ${rawMediaUrl} (${messageType}) unavailable (${mediaError}) for conv of ${senderId}`);
        }
      } else {
        mediaError = "no_channel_token";
      }
      media ??= mediaFacts({ declaredMime: senderMimeType, senderFileName });
    } else {
      // Messenger/Instagram: URL is directly usable
      resolvedMediaUrl = rawMediaUrl;
      // Their facts too (2026-10-10): the CDN's own type and size, one HEAD.
      const head = await headMetaMedia(rawMediaUrl);
      media = mediaFacts({ declaredMime: senderMimeType, downloadedMime: head.mime, byteSize: head.size, senderFileName });
      resolvedFileName = senderFileName;
    }
    // No sender name: a readable default, for the facts and the bubble alike.
    if (media && !media.originalName) {
      const storedExt = resolvedMediaUrl?.startsWith(UPLOADS_BASE_URL) ? path.extname(resolvedMediaUrl) : "";
      const name = defaultMediaName(messageType, storedExt || extFromMime(media.mimeType), new Date(normalizedMessage.timestamp ?? Date.now()));
      media = { ...media, originalName: name };
      if (!sanitizeDisplayName(senderFileName ?? undefined)) resolvedFileName = name;
    }
  }

  // Create message record with channel metadata
  // ── Quoted reply ──
  //
  // Scoped to THIS conversation, not the whole tenant. `externalMessageId` is
  // globally unique at the provider so a tenant-wide lookup would find the same
  // row, but scoping it means a corrupt or spoofed id can never attach a reply
  // to another customer's message - and it is the query the index is built for.
  //
  // A miss is normal and not an error: customers quote messages from before
  // GOTCHA was connected, and messages that were deleted. The external id is
  // kept either way so the bubble can still say a reply happened.
  let replyToMessageId: string | undefined;
  if (replyToExternalId) {
    const quoted = await prisma.message.findFirst({
      where: { tenantId, conversationId: conversation.id, externalMessageId: replyToExternalId },
      select: { id: true },
    });
    replyToMessageId = quoted?.id;
  }

  const message = await prisma.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      channel,
      externalMessageId,
      direction: "INBOUND",
      replyToExternalId,
      replyToMessageId,
      body,
      messageType,
      senderName: displayName || senderDisplayName,
      status: "DELIVERED",
      // Producer-supplied metadata (already sanitized at the edge) merges
      // under the interactive reply so a channel can attach its own
      // context - e.g. the Shopify storefront page a visitor asked from.
      metadata:
        interactiveReply || producerMetadata || mediaError || media
          ? {
              ...(producerMetadata ?? {}),
              ...(interactiveReply ? { interactiveReply } : {}),
              // Why the attachment is not here. The bubble reads this to
              // explain itself rather than showing an empty "[Document]".
              ...(mediaError ? { mediaError } : {}),
              ...(media ? { media } : {}),
            }
          : undefined,
      mediaUrl: resolvedMediaUrl,
      fileName: resolvedFileName,
    },
  });

  // "Continue on WhatsApp" from the website widget: the first message carries
  // a code; link the two conversations before anything answers, so the bot
  // already has the website chat as context. Never costs the message.
  if (channel === "WHATSAPP") {
    try {
      const { linkWebsiteHandoff } = await import("../services/whatsapp-handoff-link.service");
      const linked = await linkWebsiteHandoff({
        tenantId,
        channelAccountId,
        whatsappConversationId: conversation.id,
        whatsappContact: savedContact ? { id: savedContact.id, personId: (savedContact as any).personId ?? null } : null,
        body,
      });
      if (linked.linked) console.log(linked.websiteConversationId
        ? `[incoming] website chat ${linked.websiteConversationId} continued on WhatsApp ${conversation.id} (identity ${linked.identity})`
        : `[incoming] WhatsApp ${conversation.id} started from the website's WhatsApp widget`);
    } catch (err: any) {
      console.warn("[incoming] website handoff link failed (message kept):", err?.message);
    }
  }

  // Contact.lastInteractionAt - the column the customer list sorts and filters
  // on, which until now had exactly ONE writer: the merge carry-forward at
  // identity.ts:172, computing max(existing, existing). Nothing ever
  // initialised it, so merging two nulls yielded null and the column was
  // permanently empty - taking inactiveDays, lastInteractionBefore/After and
  // lastSeenAfter down with it.
  //
  // Written HERE, after the message is persisted, because there is nothing to
  // extend: the inbound path only READS the contact (resolveContactByChannelId
  // at the top of this function), the one contact.update on this path is
  // conditional on an avatar arriving, and Message has no relation to Contact
  // to fold a nested write into. This is an added round trip, honestly named.
  //
  // Three properties, each deliberate:
  //   updateMany, not update - a row merged away or deleted mid-flight no-ops
  //     instead of throwing P2025.
  //   not awaited, error caught - an inbound message that arrives and is NOT
  //     STORED because a sort-order timestamp threw is a catastrophic trade.
  //     Nothing here may fail the message.
  //   guarded on savedContact - most senders have no Contact row at all
  //     (contacts are created only when a message contains an email or phone),
  //     so this costs nothing for the majority.
  //
  // lastSeenAt is deliberately NOT set. On every other model in this codebase
  // it means "when a system last observed this row" - on CustomerProfile it is
  // stamped with new Date() on every pipeline pass. Making Contact.lastSeenAt
  // mean customer activity would give one name two meanings to buy a sort
  // order. Sort on lastInteractionAt instead.
  if (savedContact) {
    void prisma.contact
      .updateMany({ where: { id: savedContact.id, tenantId }, data: { lastInteractionAt: new Date() } })
      .catch((err: any) =>
        console.warn("[incoming] lastInteractionAt update failed:", err?.message ?? err),
      );
  }

  // First-inbound language detection - populates Conversation.detectedLocale
  // once per thread. Drives suggested-reply language so drafts match the
  // customer regardless of the agent's system-language setting. Idempotent
  // and fire-and-forget; subsequent inbounds short-circuit at the read.
  void (async () => {
    try {
      const { recordDetectedLocaleIfMissing } = await import("../services/locale-detect.service");
      await recordDetectedLocaleIfMissing({
        conversationId: conversation.id,
        text: body || "",
      });
    } catch (err) {
      console.warn("[incoming] locale-detect hook threw:", (err as { message?: string })?.message ?? err);
    }
  })();

  // Universal identity-link hook - fires on every persisted INBOUND so the
  // same email/phone bridging works for AI bot, FlowCanvas, AND human-handled
  // chats (co-pilot mode). The conversation service owns idempotency, so a
  // duplicate fire from the flow-executor's Collect-Input call is a no-op.
  console.log(`[incoming] identity-link hook firing for msg=${message.id} body=${(body || "").slice(0, 60)}`);
  void (async () => {
    try {
      const { tryLinkIdentifierFromInbound } = await import("../services/identity-link.service");
      await tryLinkIdentifierFromInbound({
        tenantId,
        conversationId: conversation.id,
        text: body || "",
        messageId: message.id,
        reason: "inbound message",
      });
    } catch (err: any) {
      console.warn("[incoming] identity-link hook failed:", err?.message);
    }
  })();

  // Update conversation timestamp
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  // Publish real-time events with channel info
  await publishEvent({
    event: "message:new",
    tenantId,
    data: { message, conversationId: conversation.id, channel },
  });
  await publishEvent({
    event: "conversation:updated",
    tenantId,
    data: { ...conversation, channel },
  });

  // Track analytics
  await analyticsQueue.add("message-received", {
    tenantId,
    event: "message_received",
    data: { conversationId: conversation.id, messageId: message.id, channel },
    timestamp: new Date().toISOString(),
  });

  // A "הסר" / "STOP" reply opts the customer out of marketing on this channel
  // (marketing works by opt-out: the customer's one control, so it is checked
  // before anything can answer, whoever owns the conversation). Its
  // confirmation is the only reply this message gets.
  {
    const { interceptOptOutReply } = await import("../services/marketing-optout.service");
    const handled = await interceptOptOutReply({
      tenantId, contactId: savedContact?.id ?? "", channel, conversationId: conversation.id,
      channelAccountId, recipientExternalId: senderId, messageId: message.id, messageType, body,
    });
    if (handled) return;
  }

  // No automatic "unsupported media" reply (2026-10-09). The only type that
  // triggered it was a shared location, which is not unsupported: it reaches
  // the AI as "[Shared location: ...]" with its details in metadata. Anything
  // the AI or a person cannot use is theirs to answer, in the workspace's
  // language, never a fixed English line.

  // Process bot if no agent assigned
  if (!conversation.assignedAgentId && !conversation.isHandedOver) {
    try {
      // Automations (Studio > Automations) first. A run parked on this
      // conversation takes the reply; otherwise live message automations fire.
      // One responder per inbound: when one of them answered, nothing else
      // (AI employee, playbook) answers this message too. They never run while
      // a person owns the conversation (this whole block is skipped then).
      const { automationsForInbound, automationAnsweredBefore } = await import("../services/automation-runner.service");
      const answeredByAutomation = await automationsForInbound({
        tenantId,
        conversation: conversation as any,
        messageId: message.id,
        message: body,
        channel: channel.toLowerCase(),
        replyPayload: interactiveReply?.payload ?? null,
        contactId: savedContact?.id ?? null,
        storyMention: ((producerMetadata as any)?.storyMention as { url: string | null } | undefined) ?? null,
      });
      if (answeredByAutomation) return;
      // An automation may have moved ownership while it ran (hand to AI,
      // assign); the branches below read the current row.
      conversation = (await prisma.conversation.findFirst({ where: { id: conversation.id, tenantId } })) ?? conversation;
      if (conversation.assignedAgentId || conversation.isHandedOver) return;

      // Department / role picker override (deterministic safety net).
      // When the customer taps a department-picker button ("מכירה" / "שירות"),
      // route by ROLE to an ACTIVE matching employee + set the department,
      // regardless of how the flow canvas wired the button edges. This prevents
      // a mis-wired quick-reply node (e.g. both buttons pointing at the same
      // route_target) from handing a sales lead to the support employee. Only
      // fires on recognized picker payloads; ordinary quick-replies / text fall
      // through to the normal routing path below unchanged.
      //
      // AND only when no flow is mid-execution. A parked `chatbotNodeId` means
      // an authored flow is waiting on exactly this reply, and that flow is
      // authoritative - the picker is a fallback for conversations nothing is
      // driving, not a competing routing engine. `applyDepartmentPickerReply`
      // re-checks this itself; the condition is repeated here so the common
      // case does not even reach it.
      if (interactiveReply?.payload && !(conversation as any).chatbotNodeId) {
        const { applyDepartmentPickerReply } = await import("../services/department-routing.service");
        const picked = await applyDepartmentPickerReply({
          tenantId,
          conversationId: conversation.id,
          payload: interactiveReply.payload,
          activeFlowCursor: (conversation as any).chatbotNodeId ?? null,
        });
        if (picked.handled && picked.assignedAiAgentId) {
          const { processAIBot } = await import("../services/ai-bot.service");
          await processAIBot(tenantId, conversation.id, body, picked.assignedAiAgentId);
          return;
        }
      }

      // The playbook routes the conversation's first message - or, while it
      // is still unowned, the first one after replies that were not an answer
      // (an automation's, or the system's: an opt-out confirmation, the
      // unsupported-media notice). See first-unanswered.service.
      const { isFirstUnanswered } = await import("../services/first-unanswered.service");
      const firstUnanswered = await isFirstUnanswered(tenantId, conversation as any, automationAnsweredBefore);
      if (firstUnanswered && !conversation.departmentId) {
        // New conversation - route via playbook rules
        const { routeConversation } = await import("../services/routing.service");
        const routing = await routeConversation(tenantId, conversation.id, body, channel);

        if (routing.handledByAI) {
          // AI agent or chatbot flow handled it inside routeConversation
          return;
        }
        if (routing.departmentId) {
          // Routed to department, conversation is WAITING for human
          return;
        }
        // No rule matched - conversation stays in inbox for manual pickup
      } else if (
        (conversation as any).handledBy === "ai_agent" ||
        (conversation as any).handledBy === "awaiting_approval"
      ) {
        // Ongoing AI conversation - continue processing with AI bot.
        // We keep the bot driving even while a HITL approval is still
        // pending: the AI service surfaces the pending approval to the
        // model and drops integration_* tools for that turn so the bot
        // can chat freely without re-firing the gated action and creating
        // duplicate ApprovalRequest rows. Dedupe in the dispatcher is the
        // belt-and-suspenders second line of defense.
        const { processAIBot } = await import("../services/ai-bot.service");
        await processAIBot(tenantId, conversation.id, body);
        return;
      } else if ((conversation as any).chatbotNodeId) {
        // Main FlowCanvas paused at Collect Input / Quick Reply.
        // First gate: 24h comment→DM bridge. If the bridge expired, Meta
        // blocks further DMs - close the conversation, drop chatbot state,
        // do NOT send anything back. The inbound is dropped on the floor.
        const expiresAt = (conversation as any).flowExpiresAt as Date | null;
        if (expiresAt && expiresAt.getTime() < Date.now()) {
          console.log(
            `[incoming] flow_expired conversation=${conversation.id} expired_at=${expiresAt.toISOString()}`,
          );
          await prisma.conversation.update({
            where: { id: conversation.id },
            data: {
              status: "CLOSED" as any,
              chatbotNodeId: null,
              chatbotFlowId: null,
              flowExpiresAt: null,
              closedAt: new Date(),
            },
          });
          return;
        }
        // Within window - resume the graph walker. Clear the bridge marker:
        // once the user replied, the conversation is a normal DM and isn't
        // governed by the comment-DM expiry anymore.
        if (expiresAt) {
          await prisma.conversation.update({
            where: { id: conversation.id },
            data: { flowExpiresAt: null },
          });
        }
        const { executeMainFlow, executeSubFlow } = await import("../services/flow-executor.service");
        // A sub-flow parked here resumes in THAT flow. Resuming the main
        // canvas with a node id it does not have restarted it from its entry.
        if ((conversation as any).chatbotFlowId) {
          await executeSubFlow({
            tenantId,
            conversationId: conversation.id,
            message: body,
            channel: channel.toLowerCase(),
            flowId: (conversation as any).chatbotFlowId,
            resumeNodeId: (conversation as any).chatbotNodeId,
            replyPayload: interactiveReply?.payload ?? null,
          });
          return;
        }
        await executeMainFlow({
          tenantId,
          conversationId: conversation.id,
          message: body,
          channel: channel.toLowerCase(),
          resumeNodeId: (conversation as any).chatbotNodeId,
          // `body` is the button's TITLE for an interactive reply (the webhook
          // sets it from `interactiveReply.title`), while a quick-reply edge is
          // keyed on the reply's PAYLOAD. Passing the payload is what lets the
          // resume pick the branch the customer actually tapped.
          replyPayload: interactiveReply?.payload ?? null,
        });
        return;
      }
    } catch (err) {
      console.error("Bot processing error:", err);
    }
  }
}

/**
 * Generic inbound-webhook handler. The webhook service authenticates the call,
 * resolves the WebhookTrigger by its URL token, and enqueues this job carrying
 * the raw JSON body. Here we run the linked workflow context-free: no
 * conversation, no customer - the payload is injected as flow variables under
 * `body` (n8n style), readable as `{{body.<field>}}` in downstream nodes.
 */
async function processWebhookTrigger(job: Job<WebhookTriggerJob>): Promise<void> {
  const { tenantId, workflowId, triggerId, payload, targetMode } = job.data;

  // Mirror the message path's tenant gate - don't run flows for suspended /
  // inactive tenants.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true },
  });
  if (!tenant || tenant.status !== "ACTIVE") {
    console.log(`[incoming-worker] Skipping webhook trigger for non-active tenant ${tenantId} (status: ${tenant?.status})`);
    return;
  }

  // An automation with a webhook trigger: same walk, plus a run in its log.
  // The job id is the event: BullMQ's own retries of this job run it once.
  if (targetMode !== "connected") {
    const flow = await prisma.chatbotFlow.findFirst({ where: { id: workflowId, tenantId }, select: { triggerType: true } });
    if (flow?.triggerType) {
      const { runContextFree } = await import("../services/automation-runner.service");
      const r = await runContextFree({ tenantId, flowId: workflowId, triggerType: "webhook", eventKey: `hook:${job.id}`, payload });
      console.log(`[incoming-worker] webhook-trigger automation=${workflowId} run=${r?.id ?? "duplicate"} status=${r?.status ?? "-"}`);
      return;
    }
  }

  const { executeWebhookFlow } = await import("../services/flow-executor.service");
  const mode = targetMode === "connected" ? "connected" : "flow";
  const result = await executeWebhookFlow({ tenantId, workflowId, payload, targetMode: mode });
  console.log(
    `[incoming-worker] webhook-trigger flow=${workflowId} trigger=${triggerId} mode=${mode} ` +
      `executed=${result.executed} halted=${result.halted} reason=${result.reason ?? "-"} steps=${result.trace.length}`,
  );
}

/** Automation events that do not come with an inbound message (tag added). */
async function processAutomationEvent(job: Job<AutomationEventJob>): Promise<void> {
  const ev = job.data;
  const tenant = await prisma.tenant.findUnique({ where: { id: ev.tenantId }, select: { status: true } });
  if (!tenant || tenant.status !== "ACTIVE") return;
  if (ev.type === "tag_added" && ev.contactId && ev.tag) {
    const { runTagAdded } = await import("../services/automation-runner.service");
    const r = await runTagAdded({ tenantId: ev.tenantId, contactId: ev.contactId, tag: ev.tag, eventKey: ev.eventKey });
    console.log(`[incoming-worker] automation-event tag_added contact=${ev.contactId} runs=${r.runs.length}`);
  }
  if ((ev.type === "call_missed" || ev.type === "call_answered") && typeof ev.payload?.sessionId === "string") {
    const { onCallEvent } = await import("../services/call-automation.service");
    const r = await onCallEvent({ tenantId: ev.tenantId, type: ev.type, sessionId: ev.payload.sessionId });
    console.log(`[incoming-worker] automation-event ${ev.type} session=${ev.payload.sessionId} outcome=${r.outcome}`);
  }
}

// Dispatcher: same queue, multiple job names. Keeps DM, comment-trigger, and
// webhook-trigger processing in one worker process - same Redis connection,
// same DLQ, same concurrency budget - but each job kind has its own handler.
// Exported for unit tests that exercise the job-name routing without standing
// up a real BullMQ worker.
export async function dispatch(job: Job<IncomingMessageJob | IncomingCommentJob | WebhookTriggerJob | OutboundEchoJob | HistoricalImportChunkJob>): Promise<void> {
  if (job.name === "process-comment") {
    await processCommentTrigger(job as Job<IncomingCommentJob>);
    return;
  }
  if (job.name === "process-echo") {
    // A message the BUSINESS sent from the WhatsApp Business app. OUTBOUND,
    // and it takes the conversation away from the AI - never the inbound path.
    const { processOutboundEcho } = await import("../services/outbound-echo.service");
    await processOutboundEcho(job as Job<OutboundEchoJob>);
    return;
  }
  if (job.name === "webhook-trigger") {
    await processWebhookTrigger(job as Job<WebhookTriggerJob>);
    return;
  }
  if (job.name === "cart-event") {
    const { onCartEvent } = await import("../services/cart.service");
    await onCartEvent((job as any).data);
    return;
  }
  if (job.name === "cart-check") {
    const { onCartCheck } = await import("../services/cart.service");
    const r = await onCartCheck((job as any).data);
    console.log(`[incoming-worker] cart-check checkout=${(job as any).data?.checkoutId} outcome=${r.outcome}`);
    return;
  }
  if (job.name === "order-event") {
    const { onOrderEvent } = await import("../services/order.service");
    const r = await onOrderEvent((job as any).data);
    console.log(`[incoming-worker] order-event order=${(job as any).data?.orderId} status=${(job as any).data?.status} outcome=${r.outcome}`);
    return;
  }
  if (job.name === "automation-event") {
    await processAutomationEvent(job as unknown as Job<AutomationEventJob>);
    return;
  }
  if (job.name === "process-history") {
    // A batch of the business's PAST conversations. Data import only: the
    // handler writes rows and never reaches the bot, the router or a flow.
    // This early return is what guarantees history can never fall through to
    // `processIncomingMessage` below.
    const { processHistoricalChunk } = await import("../services/historical-import.service");
    await processHistoricalChunk(job as Job<HistoricalImportChunkJob>);
    return;
  }
  // Default ("process") - DM / message path. Claimed first: a second delivery
  // of the same message is dropped here, before any contact, conversation,
  // notification or AI turn (services/inbound-dedupe.ts).
  const data = job.data as IncomingMessageJob;
  const claimArgs = { tenantId: data.tenantId, channel: data.channel, externalMessageId: data.normalizedMessage?.externalMessageId };
  const claim = await claimInboundMessage(claimArgs);
  if (claim === "duplicate") {
    console.log(`[incoming-worker] duplicate delivery dropped channel=${data.channel} tenant=${data.tenantId} mid=...${String(claimArgs.externalMessageId).slice(-12)}`);
    return;
  }
  try {
    await processIncomingMessage(job as Job<IncomingMessageJob>);
  } catch (err) {
    if (claim === "claimed") await releaseInboundClaim(claimArgs);
    throw err;
  }
}

let worker: any;
export function startIncomingWorker() {
  worker = createWorker<IncomingMessageJob | IncomingCommentJob | WebhookTriggerJob | OutboundEchoJob | HistoricalImportChunkJob>("incoming-messages", dispatch, 3);
  console.log("[incoming-worker] Incoming message worker started (handles: process, process-comment, process-echo, webhook-trigger, process-history)");
}
