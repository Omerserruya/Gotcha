/**
 * The onboarding scan job's state, kept on BusinessDiscovery.job.
 *
 * One job per tenant at a time. Every write is conditional on the row still
 * carrying THIS job's id, so a run that was superseded (a new domain, a
 * restart) stops writing the moment it next tries - it cannot overwrite the
 * newer run's feed. The worker is the only writer; routes only start and read.
 *
 * Events are stable keys + params, never copy: the UI renders the language.
 * `found` only ever grows, so one read after a reload redraws every chip.
 */
import crypto from "crypto";
import { prisma } from "@chatcenter/shared";

export type JobStatus = "QUEUED" | "RUNNING" | "COMPLETE" | "FAILED";
/** STALLED is derived at read time, never stored: RUNNING with an old heartbeat. */
export type JobView = Omit<DiscoverJob, "status"> & { status: JobStatus | "STALLED" };

export const STAGES = [
  "detect_platform",
  "harvest_platform",
  "sitemap",
  "read_pages",
  "extract",
  "write_knowledge",
  "suggest_integrations",
  "done",
] as const;
export type Stage = (typeof STAGES)[number];

export type EventKind = "progress" | "found" | "warn" | "error";

export interface JobEvent {
  seq: number;
  at: string;
  stage: Stage;
  kind: EventKind;
  key: string;
  params?: Record<string, string | number | boolean | null>;
}

export interface JobCounts {
  pagesPlanned: number;
  pagesRead: number;
  /** Pages that refused an identified crawler (403, 429, a bot challenge). */
  pagesBlocked: number;
  products: number;
  policies: number;
  faqs: number;
  documents: number;
}

export interface JobFound {
  platform: string | null;
  productCount: number;
  policies: string[];
  faqCount: number;
  contact: boolean;
  hours: boolean;
  brand: boolean;
  tools: string[];
  /** The site refuses automatic reading; the UI offers upload or paste. */
  blocked: boolean;
}

export interface DiscoverJob {
  jobId: string;
  domain: string;
  locale: string;
  status: JobStatus;
  stage: Stage;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  seq: number;
  events: JobEvent[];
  counts: JobCounts;
  found: JobFound;
  error: { code: string; stage: Stage } | null;
  /** Stages whose durable output exists; a retry skips their writes. */
  doneStages: Stage[];
}

/** A RUNNING job with no heartbeat for this long is reported STALLED. */
export const STALL_MS = 90_000;
/** The feed is a window, not a log: the newest events are what a screen shows. */
export const MAX_EVENTS = 300;

export class JobSuperseded extends Error {
  constructor() { super("job_superseded"); this.name = "JobSuperseded"; }
}

/**
 * The one typed access to the `job` column. The shared generated client may
 * predate the column in a worktree, so it is reached through this narrow shape
 * rather than casts sprinkled across the module.
 */
export interface JobDelegate {
  findUnique(a: { where: { tenantId: string }; select: { job: true } }): Promise<{ job: unknown } | null>;
  upsert(a: unknown): Promise<unknown>;
  updateMany(a: unknown): Promise<{ count: number }>;
}
let rowsOverride: JobDelegate | null = null;
const rows = (): JobDelegate => rowsOverride ?? (prisma.businessDiscovery as unknown as JobDelegate);

/** Point the store at another row source (a script's in-memory one). Null restores the database. */
export function useJobRows(delegate: JobDelegate | null): void {
  rowsOverride = delegate;
}

const emptyCounts = (): JobCounts => ({ pagesPlanned: 0, pagesRead: 0, pagesBlocked: 0, products: 0, policies: 0, faqs: 0, documents: 0 });
const emptyFound = (): JobFound => ({ platform: null, productCount: 0, policies: [], faqCount: 0, contact: false, hours: false, brand: false, tools: [], blocked: false });

export async function readJob(tenantId: string): Promise<DiscoverJob | null> {
  const row = await rows().findUnique({ where: { tenantId }, select: { job: true } });
  const job = row?.job as DiscoverJob | null | undefined;
  return job && typeof job === "object" && job.jobId ? job : null;
}

/** What a reader sees: STALLED derived, events after `since` only. */
export function viewOf(job: DiscoverJob, since = 0, now = Date.now()): JobView {
  const stalled = job.status === "RUNNING" && now - Date.parse(job.heartbeatAt) > STALL_MS;
  return {
    ...job,
    status: stalled ? "STALLED" : job.status,
    events: job.events.filter((e) => e.seq > since),
  };
}

/** Is this job still doing (or about to do) work? */
export function isLive(job: DiscoverJob | null, now = Date.now()): boolean {
  if (!job) return false;
  if (job.status === "QUEUED") return true;
  return job.status === "RUNNING" && now - Date.parse(job.heartbeatAt) <= STALL_MS;
}

/**
 * Begin a new job for this domain, superseding any other. Creates the
 * discovery row when there is none. Returns the new job.
 */
export async function startJob(tenantId: string, domain: string, locale: string, now = new Date()): Promise<DiscoverJob> {
  const job: DiscoverJob = {
    jobId: crypto.randomUUID(),
    domain,
    locale,
    status: "QUEUED",
    stage: "detect_platform",
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    finishedAt: null,
    seq: 0,
    events: [],
    counts: emptyCounts(),
    found: emptyFound(),
    error: null,
    doneStages: [],
  };
  await rows().upsert({
    where: { tenantId },
    update: { job, websiteDomain: domain },
    create: { tenantId, websiteDomain: domain, job },
  });
  return job;
}

/**
 * Apply `change` to the job, if the row still carries `jobId`. Throws
 * JobSuperseded when another run has taken over. Read-modify-write is safe
 * because exactly one worker run owns a jobId.
 */
export async function mutateJob(
  tenantId: string,
  jobId: string,
  change: (job: DiscoverJob) => void,
  now = new Date(),
): Promise<DiscoverJob> {
  const job = await readJob(tenantId);
  if (!job || job.jobId !== jobId) throw new JobSuperseded();
  change(job);
  job.heartbeatAt = now.toISOString();
  if (job.events.length > MAX_EVENTS) job.events = job.events.slice(-MAX_EVENTS);
  const res = await rows().updateMany({
    where: { tenantId, job: { path: ["jobId"], equals: jobId } },
    data: { job },
  });
  if (res.count === 0) throw new JobSuperseded();
  return job;
}

/** Push one event onto the feed (inside a mutateJob change). */
export function pushEvent(
  job: DiscoverJob,
  stage: Stage,
  kind: EventKind,
  key: string,
  params?: JobEvent["params"],
  now = new Date(),
): void {
  job.seq += 1;
  job.events.push({ seq: job.seq, at: now.toISOString(), stage, kind, key, ...(params ? { params } : {}) });
}

/** Re-open a FAILED or stalled job for a retry, keeping its feed and findings. */
export async function reopenJob(tenantId: string, jobId: string): Promise<DiscoverJob> {
  return mutateJob(tenantId, jobId, (job) => {
    job.status = "QUEUED";
    job.error = null;
    job.finishedAt = null;
    pushEvent(job, job.stage, "progress", "job.retrying");
  });
}
