/**
 * Google Drive as a knowledge source.
 *
 * A tenant connects one Drive account per knowledge base (KnowledgeIntegration
 * row, provider "google_drive") and then picks *sources*. A source is either a
 * single file or a whole folder. A folder source is the interesting one: it is
 * a standing subscription to a subtree, so every sync has to answer three
 * questions, not one:
 *
 *   * what is new in there (import it)
 *   * what changed in there (re-embed it)
 *   * what is no longer in there (drop the knowledge derived from it)
 *
 * The third question is the one that makes a folder source safe to leave
 * running. It is also the one that can destroy a customer's knowledge base if
 * we get it wrong, so deletion only ever runs off a listing we know was
 * COMPLETE. A truncated walk, a failed page, a revoked token: all of those
 * leave the existing documents alone. Silence is not evidence of deletion.
 *
 * Read-only by construction. Every call here is a GET against Drive; nothing in
 * this file creates, updates, moves, shares or deletes anything in the user's
 * Drive. The OAuth scope backing it is `drive.readonly`.
 */
import { randomUUID } from "crypto";
import { prisma, getRedis, encryptCredentials, decryptCredentials, isEncrypted } from "@chatcenter/shared";
import { parseFile } from "./file-parser.service";
import { upsertSyncedDocument } from "./embedding.service";
import { deleteByDocumentId } from "./qdrant.service";
import { logAudit } from "./audit.service";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

// ─── Types ──────────────────────────────────────────────────

export interface DriveIntegration {
  id: string;
  credentials: any;
  config?: any;
  knowledgeBaseId: string;
  tenantId: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  md5Checksum?: string;
  version?: string;
  driveId?: string;
}

export interface SharedDrive {
  id: string;
  name: string;
}

export type DriveSourceKind = "file" | "folder";

export type DriveSyncState =
  | "pending"
  | "synced"
  | "partial"
  | "failed"
  | "paused"
  | "action_required";

/**
 * One thing the admin picked. Persisted on KnowledgeIntegration.config.sources.
 *
 * `key` is the idempotency anchor: two imports of the same Drive id collapse
 * onto one source rather than producing a duplicate subscription.
 */
export interface DriveSource {
  key: string;
  kind: DriveSourceKind;
  id: string;
  name: string;
  driveId?: string;
  mimeType?: string;
  paused?: boolean;
  syncState?: DriveSyncState;
  lastSyncAt?: string;
  lastSuccessfulSyncAt?: string;
  lastError?: string;
  fileCount?: number;
}

export interface SyncCounts {
  imported: number;
  updated: number;
  skipped: number;
  removed: number;
  failed: number;
  unsupported: number;
}

function zeroCounts(): SyncCounts {
  return { imported: 0, updated: 0, skipped: 0, removed: 0, failed: 0, unsupported: 0 };
}

function addCounts(a: SyncCounts, b: SyncCounts): void {
  a.imported += b.imported; a.updated += b.updated; a.skipped += b.skipped;
  a.removed += b.removed; a.failed += b.failed; a.unsupported += b.unsupported;
}

// ─── Limits ─────────────────────────────────────────────────
//
// Read per call rather than captured at module load, so ops (and tests) can
// change them without a restart.

function limit(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const maxFolderDepth = () => limit("DRIVE_MAX_FOLDER_DEPTH", 10);
const maxFilesPerSource = () => limit("DRIVE_MAX_FILES_PER_SOURCE", 500);
/** Matches the parser's own per-file ceiling; a bigger file could not be read anyway. */
const maxFileBytes = () => limit("DRIVE_MAX_FILE_BYTES", 10 * 1024 * 1024);
const maxTotalBytesPerSource = () => limit("DRIVE_MAX_TOTAL_BYTES", 200 * 1024 * 1024);
const maxRetries = () => limit("DRIVE_MAX_RETRIES", 4);
const retryBaseMs = () => {
  const raw = Number(process.env.DRIVE_RETRY_BASE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
};
const lockTtlSeconds = () => limit("DRIVE_SYNC_LOCK_TTL", 900);

// ─── Supported content ──────────────────────────────────────
//
// Nothing here is a new parser. Google-native files are EXPORTED into a format
// the existing ingestion already reads as text; everything else is downloaded
// and handed to the existing file-parser. Adding a mime type to these tables
// without a real reader behind it would be a lie told to the picker.

const GOOGLE_EXPORT_AS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

const BINARY_SUPPORTED = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
]);

/** Read as text straight off the wire, no parser needed. */
const PLAINTEXT = new Set(["text/plain", "text/markdown", "text/x-markdown", "text/csv"]);

export function isSupportedMimeType(mimeType: string): boolean {
  return Boolean(GOOGLE_EXPORT_AS[mimeType]) || BINARY_SUPPORTED.has(mimeType);
}

/** Drive query fragment listing everything the picker may show. */
function mimeFilter(): string {
  const types = [...Object.keys(GOOGLE_EXPORT_AS), ...BINARY_SUPPORTED, FOLDER_MIME];
  return `(${types.map((m) => `mimeType='${m}'`).join(" or ")})`;
}

// ─── Errors ─────────────────────────────────────────────────

/**
 * The grant is gone (revoked, or the refresh token no longer works).
 *
 * Distinct from a transient failure on purpose: this one must stop the retry
 * loop and surface as "Action required" instead of grinding against Google
 * forever with a credential that will never work again.
 */
export class DriveAuthError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "DriveAuthError";
  }
}

/** A listing could not be completed, so its result must not drive deletions. */
export class DriveListingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveListingError";
  }
}

// ─── Credentials ────────────────────────────────────────────

interface DriveCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
}

/**
 * Read credentials whether they were stored encrypted (current) or as a plain
 * JSON object (rows written before encryption was introduced). Legacy rows are
 * re-encrypted on the next token refresh, so the estate converges without a
 * migration and without a reconnect.
 */
export function readDriveCredentials(integration: DriveIntegration): DriveCredentials {
  const raw = integration.credentials;
  if (typeof raw === "string") {
    if (!isEncrypted(raw)) throw new DriveAuthError("Stored Drive credentials are unreadable");
    return decryptCredentials(raw) as DriveCredentials;
  }
  return (raw || {}) as DriveCredentials;
}

export function writeDriveCredentials(credentials: DriveCredentials): string {
  return encryptCredentials(credentials as any);
}

// ─── HTTP ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Honour Retry-After when Google sends one; otherwise exponential with jitter. */
function backoffMs(attempt: number, retryAfter: string | null): number {
  const base = retryBaseMs();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  }
  const exponential = base * Math.pow(2, attempt);
  return Math.min(exponential + Math.random() * base, 60_000);
}

async function refreshDriveToken(integration: DriveIntegration): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new DriveAuthError("Google OAuth is not configured");

  const current = readDriveCredentials(integration);
  if (!current.refreshToken) {
    throw new DriveAuthError("No refresh token stored; the source must be reconnected");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: current.refreshToken,
    }),
  });

  if (!res.ok) {
    // invalid_grant is Google saying the user revoked us (or the token aged
    // out). Retrying cannot fix it, so it becomes a permanent error.
    const body = await res.text().catch(() => "");
    if (res.status === 400 || res.status === 401 || body.includes("invalid_grant")) {
      throw new DriveAuthError("Google access was revoked; reconnect Google Drive");
    }
    throw new Error(`Drive token refresh failed: ${res.status}`);
  }

  const data: any = await res.json();
  const next: DriveCredentials = {
    ...current,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };

  await prisma.knowledgeIntegration.update({
    where: { id: integration.id },
    data: { credentials: writeDriveCredentials(next) as any },
  });

  integration.credentials = writeDriveCredentials(next);
  return next.accessToken;
}

/**
 * One authenticated Drive GET, with a single 401 re-auth and bounded retries
 * for the transient statuses. Anything else is returned to the caller as-is so
 * it can decide whether a 404 means "gone" or "never existed".
 */
async function driveFetch(integration: DriveIntegration, url: string): Promise<Response> {
  let token = readDriveCredentials(integration).accessToken;
  let refreshed = false;
  const attempts = maxRetries();

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (res.status === 401 && !refreshed) {
      refreshed = true;
      token = await refreshDriveToken(integration);
      continue;
    }
    if (res.status === 401) {
      throw new DriveAuthError("Google rejected the refreshed access token");
    }
    if (RETRYABLE_STATUS.has(res.status) && attempt < attempts) {
      await sleep(backoffMs(attempt, res.headers.get("retry-after")));
      continue;
    }
    return res;
  }
}

async function driveJson(integration: DriveIntegration, url: string): Promise<any> {
  const res = await driveFetch(integration, url);
  if (!res.ok) throw new DriveListingError(`Drive API error: ${res.status}`);
  return res.json();
}

// ─── Listing ────────────────────────────────────────────────

export async function listSharedDrives(integration: DriveIntegration): Promise<SharedDrive[]> {
  const drives: SharedDrive[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ pageSize: "100", fields: "nextPageToken,drives(id,name)" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await driveJson(integration, `${DRIVE_API}/drives?${params}`);
    for (const d of data.drives || []) drives.push({ id: d.id, name: d.name });
    pageToken = data.nextPageToken;
  } while (pageToken);

  return drives;
}

const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,md5Checksum,version,driveId";

/** Every child of one folder, following nextPageToken to the end. */
async function listChildren(
  integration: DriveIntegration,
  parentId: string,
  driveId?: string,
): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${parentId}' in parents and trashed=false and ${mimeFilter()}`,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: "200",
      // Shared Drive content is invisible to a query without both of these.
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (driveId) {
      // Scope the search to the one Shared Drive instead of sweeping every
      // drive the user can see.
      params.set("driveId", driveId);
      params.set("corpora", "drive");
    }
    if (pageToken) params.set("pageToken", pageToken);

    const data = await driveJson(integration, `${DRIVE_API}/files?${params}`);
    for (const f of data.files || []) out.push(f as DriveFile);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return out;
}

/** Picker listing: one level, folders first. */
export async function listFiles(
  integration: DriveIntegration,
  folderId?: string,
  driveId?: string,
): Promise<DriveFile[]> {
  // A Shared Drive's root folder id IS the drive id, which is why driveId can
  // stand in as the parent when no folder is given.
  const parent = folderId || driveId || "root";
  const files = await listChildren(integration, parent, driveId);

  files.sort((a, b) => {
    const aFolder = a.mimeType === FOLDER_MIME ? 0 : 1;
    const bFolder = b.mimeType === FOLDER_MIME ? 0 : 1;
    if (aFolder !== bFolder) return aFolder - bFolder;
    return a.name.localeCompare(b.name);
  });

  return files;
}

export interface FolderScan {
  files: DriveFile[];
  /** True when a limit stopped the walk. A truncated scan must NOT delete anything. */
  truncated: boolean;
  truncationReason?: string;
  foldersVisited: number;
  unsupported: number;
}

/**
 * Every supported file under a folder, recursively.
 *
 * Breadth-first with a visited set: Drive lets a file live under several
 * parents, and a shortcut chain can point back up the tree, so without the set
 * a sync could walk in circles or import the same document repeatedly.
 */
export async function scanFolder(
  integration: DriveIntegration,
  folderId: string,
  driveId?: string,
): Promise<FolderScan> {
  const depthLimit = maxFolderDepth();
  const fileLimit = maxFilesPerSource();
  const byteLimit = maxTotalBytesPerSource();
  const perFileLimit = maxFileBytes();

  const visited = new Set<string>([folderId]);
  const seenFiles = new Set<string>();
  const files: DriveFile[] = [];
  let queue: Array<{ id: string; depth: number }> = [{ id: folderId, depth: 0 }];
  let foldersVisited = 0;
  let unsupported = 0;
  let totalBytes = 0;
  let truncated = false;
  let truncationReason: string | undefined;

  while (queue.length > 0 && !truncated) {
    const next: Array<{ id: string; depth: number }> = [];

    for (const folder of queue) {
      const children = await listChildren(integration, folder.id, driveId);
      foldersVisited++;

      for (const child of children) {
        if (child.mimeType === FOLDER_MIME) {
          if (visited.has(child.id)) continue;
          if (folder.depth + 1 > depthLimit) {
            truncated = true;
            truncationReason = `Folder nesting deeper than ${depthLimit} levels was not scanned`;
            continue;
          }
          visited.add(child.id);
          next.push({ id: child.id, depth: folder.depth + 1 });
          continue;
        }

        if (!isSupportedMimeType(child.mimeType)) { unsupported++; continue; }
        if (seenFiles.has(child.id)) continue;

        const size = Number(child.size || 0);
        if (size > perFileLimit) { unsupported++; continue; }

        if (files.length >= fileLimit) {
          truncated = true;
          truncationReason = `More than ${fileLimit} files in this folder; only the first ${fileLimit} were imported`;
          break;
        }
        if (totalBytes + size > byteLimit) {
          truncated = true;
          truncationReason = `Folder exceeds the ${Math.round(byteLimit / 1024 / 1024)}MB import budget`;
          break;
        }

        seenFiles.add(child.id);
        totalBytes += size;
        files.push(child);
      }

      if (truncated) break;
    }

    queue = next;
  }

  return { files, truncated, truncationReason, foldersVisited, unsupported };
}

// ─── Content ────────────────────────────────────────────────

export async function fetchFileContent(
  integration: DriveIntegration,
  fileId: string,
  mimeType: string,
): Promise<string> {
  const exportAs = GOOGLE_EXPORT_AS[mimeType];
  if (exportAs) {
    const res = await driveFetch(
      integration,
      `${DRIVE_API}/files/${fileId}/export?mimeType=${encodeURIComponent(exportAs)}&supportsAllDrives=true`,
    );
    if (!res.ok) throw new Error(`Drive export error: ${res.status}`);
    return (await res.text()).trim();
  }

  const res = await driveFetch(
    integration,
    `${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`,
  );
  if (!res.ok) throw new Error(`Drive download error: ${res.status}`);

  if (PLAINTEXT.has(mimeType)) return (await res.text()).trim();

  const buffer = Buffer.from(await res.arrayBuffer());
  return parseFile(buffer, mimeType);
}

async function fetchFileMeta(
  integration: DriveIntegration,
  fileId: string,
): Promise<DriveFile | null> {
  const res = await driveFetch(
    integration,
    `${DRIVE_API}/files/${fileId}?fields=${FILE_FIELDS},trashed&supportsAllDrives=true`,
  );
  // 404 also covers "you can no longer see this", which is what a revoked share
  // looks like from here.
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new DriveListingError(`Drive metadata error: ${res.status}`);
  const meta: any = await res.json();
  return meta.trashed ? null : (meta as DriveFile);
}

// ─── Ingestion ──────────────────────────────────────────────

export function driveSourceUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}`;
}

/**
 * A change marker that survives the formats Drive reports differently.
 * md5 is the strongest signal, version next, modifiedTime last: a Google Doc
 * has no checksum, and a binary re-uploaded with identical bytes should not
 * cost an embedding run.
 */
function changeKeyFor(file: DriveFile): string {
  return file.md5Checksum || file.version || String(file.modifiedTime || "");
}

type IngestOutcome = "created" | "updated" | "skipped" | "unsupported" | "failed";

async function ingestFile(
  integration: DriveIntegration,
  file: DriveFile,
  folderSourceId: string | null,
): Promise<IngestOutcome> {
  if (!isSupportedMimeType(file.mimeType)) return "unsupported";

  try {
    const content = await fetchFileContent(integration, file.id, file.mimeType);
    if (!content) return "skipped";

    const outcome = await upsertSyncedDocument({
      knowledgeBaseId: integration.knowledgeBaseId,
      tenantId: integration.tenantId,
      title: file.name,
      content,
      sourceType: "google_drive",
      sourceUrl: driveSourceUrl(file.id),
      changeKey: changeKeyFor(file),
      metadata: {
        integrationId: integration.id,
        driveFileId: file.id,
        mimeType: file.mimeType,
        // Which folder source claims this document. Reconciliation reads it to
        // decide what is still inside the subtree, so a standalone file source
        // (null here) is never swept up by a folder's cleanup.
        driveFolderSourceId: folderSourceId,
        driveId: file.driveId || null,
      },
    });
    return outcome;
  } catch (err: any) {
    // Deliberately id-only: file names are customer content and this line goes
    // to the service log, not to the tenant's audit trail.
    console.error(`[GoogleDrive] Failed to ingest file ${file.id}: ${err?.message}`);
    if (err instanceof DriveAuthError) throw err;
    return "failed";
  }
}

// ─── Reconciliation ─────────────────────────────────────────

/**
 * Drop knowledge derived from files that are no longer in the folder.
 *
 * Covers deletion, trashing, a move out of the subtree and a revoked share
 * identically, because from Drive's side they are all "the listing no longer
 * contains it". Only ever called with a listing known to be complete.
 */
async function reconcileFolder(
  integration: DriveIntegration,
  folderSourceId: string,
  liveFileIds: Set<string>,
): Promise<number> {
  const documents = await prisma.knowledgeDocument.findMany({
    where: {
      tenantId: integration.tenantId,
      knowledgeBaseId: integration.knowledgeBaseId,
      sourceType: "google_drive",
    },
    select: { id: true, metadata: true },
  });

  let removed = 0;
  for (const doc of documents) {
    const meta = (doc.metadata || {}) as any;
    if (meta.integrationId !== integration.id) continue;
    if (meta.driveFolderSourceId !== folderSourceId) continue;
    if (!meta.driveFileId || liveFileIds.has(meta.driveFileId)) continue;

    await deleteByDocumentId(doc.id).catch((err) =>
      console.error(`[GoogleDrive] Qdrant cleanup failed for ${doc.id}: ${err?.message}`),
    );
    // Chunk rows cascade from the document row.
    await prisma.knowledgeDocument.delete({ where: { id: doc.id } });
    removed++;
  }

  return removed;
}

/** Everything this integration imported for one source, removed. */
export async function removeSourceData(
  integration: DriveIntegration,
  predicate: (meta: any) => boolean,
): Promise<number> {
  const documents = await prisma.knowledgeDocument.findMany({
    where: {
      tenantId: integration.tenantId,
      knowledgeBaseId: integration.knowledgeBaseId,
      sourceType: "google_drive",
    },
    select: { id: true, metadata: true },
  });

  let removed = 0;
  for (const doc of documents) {
    const meta = (doc.metadata || {}) as any;
    if (meta.integrationId !== integration.id) continue;
    if (!predicate(meta)) continue;

    await deleteByDocumentId(doc.id).catch(() => undefined);
    await prisma.knowledgeDocument.delete({ where: { id: doc.id } });
    removed++;
  }
  return removed;
}

// ─── Source state ───────────────────────────────────────────

export function sourceKey(kind: DriveSourceKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * The selection this integration is subscribed to.
 *
 * Reads the structured `sources` list when present and falls back to the
 * pre-folder `fileIds` array otherwise, so an integration connected before
 * folder support keeps syncing with no migration and no reconnect. Legacy ids
 * are typed from their live mime type at sync time, which is also how the old
 * code behaved when someone passed it a folder id.
 */
export function normalizeSources(config: any): DriveSource[] {
  const cfg = config && typeof config === "object" ? config : {};

  if (Array.isArray(cfg.sources) && cfg.sources.length > 0) {
    return cfg.sources
      .filter((s: any) => s && typeof s.id === "string" && s.id)
      .map((s: any) => ({
        ...s,
        kind: s.kind === "folder" ? "folder" : "file",
        key: s.key || sourceKey(s.kind === "folder" ? "folder" : "file", s.id),
        name: s.name || s.id,
      }));
  }

  if (Array.isArray(cfg.fileIds)) {
    return cfg.fileIds
      .filter((id: any) => typeof id === "string" && id)
      .map((id: string) => ({
        key: sourceKey("file", id),
        kind: "file" as const,
        id,
        name: id,
        syncState: "pending" as const,
      }));
  }

  return [];
}

/** Merge newly picked sources into the persisted list without losing state. */
export function mergeSources(existing: DriveSource[], picked: DriveSource[]): DriveSource[] {
  const byKey = new Map(existing.map((s) => [s.key, s]));
  for (const p of picked) {
    const prev = byKey.get(p.key);
    byKey.set(p.key, prev ? { ...prev, ...p, syncState: prev.syncState, paused: prev.paused } : p);
  }
  return [...byKey.values()];
}

async function persistSources(integration: DriveIntegration, sources: DriveSource[]): Promise<void> {
  const cfg = (integration.config && typeof integration.config === "object" ? integration.config : {}) as any;
  const nextConfig = { ...cfg, sources, lastSyncAt: new Date().toISOString() };
  await prisma.knowledgeIntegration.update({
    where: { id: integration.id },
    data: { config: nextConfig },
  });
  integration.config = nextConfig;
}

// ─── Locking ────────────────────────────────────────────────

/**
 * One sync per integration at a time.
 *
 * The hourly tick and a "Sync now" click can land together, and two concurrent
 * walks of the same folder would race on the same document rows. Rather than
 * making every write path race-proof, the whole sync is serialised per
 * integration; a second caller is told to come back rather than queued.
 */
export async function withSyncLock<T>(
  integrationId: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const redis = getRedis();
  const key = `drive-sync-lock:${integrationId}`;
  const token = randomUUID();

  const acquired = await redis.set(key, token, "EX", lockTtlSeconds(), "NX");
  if (!acquired) return null;

  try {
    return await fn();
  } finally {
    // Only release a lock we still hold: if the TTL already expired and another
    // worker took over, deleting the key would hand a third worker the lock.
    const held = await redis.get(key).catch(() => null);
    if (held === token) await redis.del(key).catch(() => undefined);
  }
}

// ─── Sync ───────────────────────────────────────────────────

export interface SourceSyncResult {
  key: string;
  counts: SyncCounts;
  state: DriveSyncState;
  error?: string;
  truncated?: boolean;
  fileCount?: number;
}

async function syncOneSource(
  integration: DriveIntegration,
  source: DriveSource,
): Promise<SourceSyncResult> {
  const counts = zeroCounts();

  const meta = await fetchFileMeta(integration, source.id);
  if (!meta) {
    // The source itself is gone or no longer visible. Its imported knowledge is
    // deliberately left in place: removing a customer's knowledge base without
    // them asking is not a recovery step. They can Remove imported data.
    return {
      key: source.key,
      counts,
      state: "action_required",
      error: "This item is no longer available in Google Drive",
    };
  }

  // ── Single file ──
  if (meta.mimeType !== FOLDER_MIME) {
    const outcome = await ingestFile(integration, { ...meta, id: source.id }, null);
    if (outcome === "created") counts.imported++;
    else if (outcome === "updated") counts.updated++;
    else if (outcome === "skipped") counts.skipped++;
    else if (outcome === "unsupported") counts.unsupported++;
    else counts.failed++;

    return {
      key: source.key,
      counts,
      state: outcome === "failed" ? "failed" : outcome === "unsupported" ? "partial" : "synced",
      error: outcome === "unsupported" ? "This file type is not supported" : undefined,
      fileCount: outcome === "unsupported" || outcome === "failed" ? 0 : 1,
    };
  }

  // ── Folder ──
  const scan = await scanFolder(integration, source.id, source.driveId || meta.driveId);
  counts.unsupported += scan.unsupported;

  for (const file of scan.files) {
    const outcome = await ingestFile(integration, file, source.id);
    if (outcome === "created") counts.imported++;
    else if (outcome === "updated") counts.updated++;
    else if (outcome === "skipped") counts.skipped++;
    else if (outcome === "unsupported") counts.unsupported++;
    else counts.failed++;
  }

  // Deletion only off a listing we know is complete. A truncated walk saw a
  // subset of the folder, and treating "not seen" as "deleted" there would wipe
  // knowledge that is still perfectly present in Drive.
  if (!scan.truncated) {
    counts.removed += await reconcileFolder(
      integration,
      source.id,
      new Set(scan.files.map((f) => f.id)),
    );
  }

  const state: DriveSyncState =
    counts.failed > 0 || scan.truncated ? "partial" : "synced";

  return {
    key: source.key,
    counts,
    state,
    truncated: scan.truncated,
    error: scan.truncated
      ? scan.truncationReason
      : counts.failed > 0
        ? `${counts.failed} file(s) could not be imported`
        : undefined,
    fileCount: scan.files.length,
  };
}

export interface SyncRunResult {
  counts: SyncCounts;
  sources: SourceSyncResult[];
  /** Null when another sync already holds the lock. */
  skippedLocked?: boolean;
}

/**
 * Sync every non-paused source on an integration.
 *
 * A failure on one source is recorded on that source and does not abort the
 * others: one unreadable folder should not stop the rest of a knowledge base
 * from staying current. A revoked grant is the exception, because every
 * remaining source would fail the same way.
 */
export async function syncIntegration(
  integration: DriveIntegration,
  opts: { actorId?: string; onlyKeys?: string[] } = {},
): Promise<SyncRunResult | null> {
  return withSyncLock(integration.id, async () => {
    const all = normalizeSources(integration.config);
    const selected = opts.onlyKeys?.length
      ? all.filter((s) => opts.onlyKeys!.includes(s.key))
      : all;

    const totals = zeroCounts();
    const results: SourceSyncResult[] = [];
    let authRevoked = false;

    for (const source of selected) {
      if (source.paused) continue;

      let result: SourceSyncResult;
      try {
        result = await syncOneSource(integration, source);
      } catch (err: any) {
        if (err instanceof DriveAuthError) {
          authRevoked = true;
          result = { key: source.key, counts: zeroCounts(), state: "action_required", error: err.message };
        } else {
          console.error(`[GoogleDrive] source ${source.key} failed: ${err?.message}`);
          result = { key: source.key, counts: zeroCounts(), state: "failed", error: err?.message || "Sync failed" };
        }
      }

      addCounts(totals, result.counts);
      results.push(result);

      const now = new Date().toISOString();
      source.syncState = result.state;
      source.lastSyncAt = now;
      source.lastError = result.error;
      if (result.fileCount !== undefined) source.fileCount = result.fileCount;
      if (result.state === "synced") source.lastSuccessfulSyncAt = now;

      // Nothing else can succeed once the grant is gone; mark the rest rather
      // than hammering Google with a credential it has already rejected.
      if (authRevoked) {
        for (const rest of selected) {
          if (rest.key === source.key || rest.paused) continue;
          if (rest.syncState !== "action_required") {
            rest.syncState = "action_required";
            rest.lastError = "Google access was revoked; reconnect Google Drive";
          }
        }
        break;
      }
    }

    await persistSources(integration, all);

    await logAudit({
      tenantId: integration.tenantId,
      actor: opts.actorId ? { type: "user", id: opts.actorId } : { type: "system" },
      action: "knowledge.drive.sync",
      target: { type: "knowledge_integration", id: integration.id },
      // Counts and source keys only. File names are customer content and have
      // no business being copied into an audit payload.
      metadata: {
        sources: results.map((r) => ({ key: r.key, state: r.state, ...r.counts })),
        totals,
        revoked: authRevoked,
      },
    });

    return { counts: totals, sources: results };
  });
}

// ─── Backwards-compatible entry point ───────────────────────

/**
 * The pre-folder API: a bare list of Drive ids.
 *
 * Still used by callers that only ever dealt with files. Ids are typed from
 * their live mime type, so passing a folder id here behaves the same way it
 * always did (recurse into it) while now also gaining deletion tracking.
 */
export async function syncFiles(
  integration: DriveIntegration,
  fileIds: string[],
): Promise<SyncCounts> {
  const sources: DriveSource[] = fileIds.map((id) => ({
    key: sourceKey("file", id),
    kind: "file",
    id,
    name: id,
  }));

  const existing = normalizeSources(integration.config);
  const merged = mergeSources(existing, sources);
  const cfg = (integration.config && typeof integration.config === "object" ? integration.config : {}) as any;
  integration.config = { ...cfg, sources: merged };

  const run = await syncIntegration(integration, { onlyKeys: sources.map((s) => s.key) });
  return run ? run.counts : zeroCounts();
}
