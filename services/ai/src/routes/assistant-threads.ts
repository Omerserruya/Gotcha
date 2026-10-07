/**
 * /api/assistant: Home chat threads (docs/api/assistant-threads-v1.md, stage 1).
 * A thread is its owner's only: another user's id answers 404 like a missing one.
 * The answer's events come from the run store, so the first stream, a
 * reconnect and a reload all read the same list (services/assistant-threads).
 */
import { Router, type Request, type Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requirePermissionOrRole,
  viewerOf,
  prisma,
  getRedis,
  assertAiAllowed,
} from "@chatcenter/shared";
import {
  normalizeScope,
  createThread,
  listThreads,
  patchThread,
  deleteThread,
  ownThread,
  threadView,
  startRun,
  readEvents,
  runMeta,
  requestCancel,
  type Owner,
} from "../services/assistant-threads.service";

const router = Router();

// Same gate as the Command Center: the assistant reads the workspace's
// conversations, and what it reads follows the inbox's visibility rule.
router.use(authenticate, resolveTenant, requireActiveTenant(), requirePermissionOrRole("conversation:messages:read", "ADMIN"));

const MAX_TEXT = 4000;
const RATE_PER_MIN = 10;
const PING_MS = 25_000;
const TAIL_MS = 150;

function ownerOf(req: Request): Owner | null {
  const userId = ((req as any).user?.userId ?? (req as any).user?.id) as string | undefined;
  return userId ? { tenantId: req.tenantId!, userId } : null;
}
const notFound = (res: Response) => res.status(404).json({ error: "Thread not found", code: "THREAD_NOT_FOUND" });

router.post("/threads", async (req: Request, res: Response) => {
  const o = ownerOf(req);
  if (!o) { res.status(401).json({ error: "no user context" }); return; }
  const scope = normalizeScope(req.body?.scope);
  if (!scope) { res.status(400).json({ error: "Invalid scope", code: "INVALID_SCOPE" }); return; }
  res.status(201).json({ data: await createThread(o, scope) });
});

router.get("/threads", async (req: Request, res: Response) => {
  const o = ownerOf(req);
  if (!o) { res.status(401).json({ error: "no user context" }); return; }
  const r = await listThreads(o, {
    limit: Number(req.query.limit) || 20,
    cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
    archived: req.query.archived === "1" || req.query.archived === "true",
  });
  res.json(r);
});

router.get("/threads/:id", async (req: Request, res: Response) => {
  const o = ownerOf(req);
  if (!o) { res.status(401).json({ error: "no user context" }); return; }
  const v = await threadView(o, String(req.params.id));
  if (!v) { notFound(res); return; }
  res.json({ data: v });
});

router.patch("/threads/:id", async (req: Request, res: Response) => {
  const o = ownerOf(req);
  if (!o) { res.status(401).json({ error: "no user context" }); return; }
  const b = req.body ?? {};
  const patch: Parameters<typeof patchThread>[2] = {};
  if (b.title !== undefined) {
    const t = typeof b.title === "string" ? b.title.trim() : "";
    if (!t) { res.status(400).json({ error: "Title required", code: "TEXT_REQUIRED" }); return; }
    if (t.length > 120) { res.status(400).json({ error: "Title too long", code: "TITLE_TOO_LONG", max: 120 }); return; }
    patch.title = t;
  }
  if (b.scope !== undefined) {
    const s = normalizeScope(b.scope);
    if (!s) { res.status(400).json({ error: "Invalid scope", code: "INVALID_SCOPE" }); return; }
    patch.scope = s;
  }
  if (b.archived !== undefined) patch.archived = !!b.archived;
  const t = await patchThread(o, String(req.params.id), patch);
  if (!t) { notFound(res); return; }
  res.json({ data: t });
});

router.delete("/threads/:id", async (req: Request, res: Response) => {
  const o = ownerOf(req);
  if (!o) { res.status(401).json({ error: "no user context" }); return; }
  if (!(await deleteThread(o, String(req.params.id)))) { notFound(res); return; }
  res.status(204).end();
});

/** The interface language: the request's, then the user's, then the workspace's. */
async function localeOf(req: Request, o: Owner): Promise<"he" | "en"> {
  const asked = req.body?.locale;
  if (asked === "he" || asked === "en") return asked;
  const [u, t] = await Promise.all([
    prisma.user.findUnique({ where: { id: o.userId }, select: { locale: true } }).catch(() => null),
    prisma.tenant.findUnique({ where: { id: o.tenantId }, select: { defaultLocale: true } }).catch(() => null),
  ]);
  const l = String(u?.locale || t?.defaultLocale || "en").toLowerCase();
  return l.startsWith("he") ? "he" : "en";
}

/** At most RATE_PER_MIN messages a minute per user. Null when allowed, else seconds to wait. */
async function rateLimited(o: Owner): Promise<number | null> {
  const now = Date.now();
  const window = Math.floor(now / 60_000);
  const key = `assistant:rate:${o.tenantId}:${o.userId}:${window}`;
  const r = getRedis();
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, 70);
  return n > RATE_PER_MIN ? Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000)) : null;
}

/** Stream the run's events after `after`, live, until message.done (or the client leaves). */
async function tail(req: Request, res: Response, runId: string, after: number) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  let closed = false;
  req.on("close", () => { closed = true; });
  const ping = setInterval(() => { if (!closed) res.write(": ping\n\n"); }, PING_MS);
  let seq = after;
  try {
    while (!closed) {
      const events = await readEvents(runId, seq);
      for (const e of events) {
        res.write(`id: ${runId}:${e.seq}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
        seq = e.seq;
        if (e.event === "message.done") { closed = true; break; }
      }
      if (closed) break;
      if (!events.length && !(await runMeta(runId))) break; // expired underneath us
      await new Promise((ok) => setTimeout(ok, TAIL_MS));
    }
  } finally {
    clearInterval(ping);
    res.end();
  }
}

router.post("/threads/:id/messages", async (req: Request, res: Response) => {
  const o = ownerOf(req);
  if (!o) { res.status(401).json({ error: "no user context" }); return; }
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) { res.status(400).json({ error: "Text required", code: "TEXT_REQUIRED" }); return; }
  if (text.length > MAX_TEXT) { res.status(400).json({ error: "Text too long", code: "TEXT_TOO_LONG", max: MAX_TEXT }); return; }
  const thread = await ownThread(o, String(req.params.id));
  if (!thread) { notFound(res); return; }

  const wait = await rateLimited(o);
  if (wait) { res.status(429).json({ error: "Too many messages", code: "RATE_LIMITED", retryAfterSeconds: wait }); return; }
  try {
    await assertAiAllowed(o.tenantId);
  } catch (err: any) {
    if (err?.name === "AiUnitsExhaustedError") {
      res.status(402).json({ error: "AI is not available for this workspace right now", code: err.reason ?? "AI_UNITS_EXHAUSTED" });
      return;
    }
    throw err;
  }

  const [user, tenant] = await Promise.all([
    prisma.user.findUnique({ where: { id: o.userId }, select: { name: true, email: true, role: true } }).catch(() => null),
    prisma.tenant.findUnique({ where: { id: o.tenantId }, select: { name: true } }).catch(() => null),
  ]);
  const started = await startRun({
    owner: o,
    thread: { id: thread.id, scope: thread.scope, title: thread.title, titleSource: thread.titleSource },
    text,
    locale: await localeOf(req, o),
    operator: { userName: user?.name ?? undefined, userEmail: user?.email ?? undefined, userRole: user?.role ?? undefined, tenantName: tenant?.name ?? undefined, viewer: viewerOf(req) },
    authToken: (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || undefined,
  });
  if (!started) { res.status(409).json({ error: "An answer is still being written", code: "RUN_IN_PROGRESS" }); return; }
  await tail(req, res, started.runId, 0);
});

router.get("/threads/:id/runs/:runId/events", async (req: Request, res: Response) => {
  const o = ownerOf(req);
  if (!o) { res.status(401).json({ error: "no user context" }); return; }
  const thread = await ownThread(o, String(req.params.id));
  if (!thread) { notFound(res); return; }
  const runId = String(req.params.runId);
  const meta = await runMeta(runId);
  if (!meta || meta.threadId !== thread.id) { res.status(410).json({ error: "This answer can no longer be resumed", code: "RUN_EXPIRED" }); return; }
  const last = String(req.headers["last-event-id"] ?? "");
  const fromHeader = last.startsWith(`${runId}:`) ? Number(last.slice(runId.length + 1)) : NaN;
  const after = Number.isFinite(fromHeader) ? fromHeader : Math.max(0, Number(req.query.after) || 0);
  await tail(req, res, runId, Math.max(0, Math.floor(after)));
});

router.post("/threads/:id/messages/:messageId/cancel", async (req: Request, res: Response) => {
  const o = ownerOf(req);
  if (!o) { res.status(401).json({ error: "no user context" }); return; }
  const thread = await ownThread(o, String(req.params.id));
  if (!thread) { notFound(res); return; }
  const m = await prisma.assistantMessage.findFirst({ where: { id: String(req.params.messageId), threadId: thread.id }, select: { status: true, runId: true } });
  if (!m) { res.status(404).json({ error: "Message not found", code: "MESSAGE_NOT_FOUND" }); return; }
  if (m.status !== "streaming" || !m.runId) { res.json({ data: { status: m.status } }); return; }
  await requestCancel(m.runId);
  res.status(202).json({ data: { status: "cancelling" } });
});

export default router;
