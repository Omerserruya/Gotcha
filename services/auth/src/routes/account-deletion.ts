/**
 * Account deletion requests. Contract: release-next-kit/account-deletion/CONTRACT.md
 * (agreed with Frontend 2026-11-14). The public pair needs no session: the
 * frontend's own server calls it for /{he|en}/account-deletion.
 */
import { Router, Request, Response } from "express";
import { authenticate, requireSystemAdmin } from "@chatcenter/shared";
import {
  DeletionError, requestPublic, confirm, requestInApp, getMine, cancelMine, listForOperator, complete, reject,
} from "../services/account-deletion.service";

const router = Router();

function fail(res: Response, err: unknown, where: string) {
  if (err instanceof DeletionError) {
    const { retryAfter, ...extra } = err.extra as any;
    if (retryAfter) res.setHeader("Retry-After", String(retryAfter));
    res.status(err.status).json({ error: err.code, code: err.code, ...extra });
    return;
  }
  console.error(`[account-deletion] ${where} failed:`, (err as any)?.message ?? err);
  res.status(500).json({ error: "INTERNAL", code: "INTERNAL" });
}

/** The caller's address as nginx saw it (the gateway sets X-Real-IP). */
const clientIp = (req: Request) =>
  (req.headers["x-real-ip"] as string) || (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.ip;

// ─── Public ─────────────────────────────────────────────────

router.post("/request", async (req, res) => {
  try {
    const { email, workspace, locale } = req.body ?? {};
    res.status(202).json({ data: await requestPublic({ email, workspace, locale, ip: clientIp(req) }) });
  } catch (err) { fail(res, err, "request"); }
});

router.post("/confirm", async (req, res) => {
  try {
    res.status(200).json({ data: await confirm(req.body?.token) });
  } catch (err) { fail(res, err, "confirm"); }
});

// ─── Signed in ──────────────────────────────────────────────

router.post("/me", authenticate, async (req, res) => {
  try { res.status(201).json({ data: await requestInApp(req.user!.userId, req.body?.reason) }); }
  catch (err) { fail(res, err, "me:create"); }
});
router.get("/me", authenticate, async (req, res) => {
  try { res.json({ data: await getMine(req.user!.userId) }); }
  catch (err) { fail(res, err, "me:get"); }
});
router.delete("/me", authenticate, async (req, res) => {
  try { res.json({ data: await cancelMine(req.user!.userId) }); }
  catch (err) { fail(res, err, "me:cancel"); }
});

export default router;

// ─── Operator (mounted under /api/system) ───────────────────

export const operatorRouter = Router();
operatorRouter.get("/account-deletion-requests", authenticate, requireSystemAdmin(), async (req, res) => {
  try { res.json({ data: await listForOperator(typeof req.query.status === "string" ? req.query.status : undefined) }); }
  catch (err) { fail(res, err, "op:list"); }
});
operatorRouter.post("/account-deletion-requests/:id/complete", authenticate, requireSystemAdmin(), async (req, res) => {
  try {
    const eraseWorkspaces = Array.isArray(req.body?.eraseWorkspaces) ? req.body.eraseWorkspaces.filter((x: unknown) => typeof x === "string") : [];
    res.json({ data: await complete(req.params.id as string, req.user!.userId, { eraseWorkspaces }) });
  } catch (err) { fail(res, err, "op:complete"); }
});
operatorRouter.post("/account-deletion-requests/:id/reject", authenticate, requireSystemAdmin(), async (req, res) => {
  try { res.json({ data: await reject(req.params.id as string, req.user!.userId, req.body?.reason) }); }
  catch (err) { fail(res, err, "op:reject"); }
});
