/**
 * Realtime handshake tickets.
 *
 *   POST /api/realtime/ticket  -> { data: { ticket, expiresInSeconds } }
 *
 * Mounted in the auth service because a ticket is an identity artifact: it
 * says who a socket is, and nothing about conversations or notifications. Both
 * socket servers redeem it through the same shared helper, so there is one
 * definition of what a ticket means and one place it can be revoked.
 *
 * Open to every authenticated tenant member. A ticket confers exactly the
 * principal the caller already holds - it cannot widen a role, and its tenant
 * is fixed at mint time - so gating it by role would only stop agents from
 * opening the inbox socket they are entitled to.
 */
import { Router, type Request, type Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireActiveTenant,
  issueRealtimeTicket,
} from "@chatcenter/shared";

const router = Router();

router.post(
  "/ticket",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  async (req: Request, res: Response) => {
    // An internal service call has no browser and no socket to open. Minting a
    // ticket for one would produce a credential acting as "system" in a tenant,
    // redeemable by whoever received it - so the door is shut explicitly rather
    // than left to whether any caller happens to try.
    if ((req.user as any)?.isInternal) {
      res.status(403).json({ error: "Realtime tickets are for user sessions only" });
      return;
    }
    try {
      const { ticket, expiresInSeconds } = await issueRealtimeTicket(req.user as any);
      // No-store is not decoration: a ticket is single-use, and a cached copy
      // is a copy that has already been spent by the time anyone replays it.
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: { ticket, expiresInSeconds } });
    } catch (err) {
      // Redis is down. Fail closed and say so plainly - a socket that cannot
      // be authenticated must not be opened unauthenticated.
      console.error("[realtime] ticket issue failed:", err);
      res.status(503).json({ error: "Realtime tickets are temporarily unavailable" });
    }
  },
);

export default router;
