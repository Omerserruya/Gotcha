/**
 * The public sign-up.
 *
 *   GET  /api/auth/signup/config   is sign-up open, and what does it promise
 *   POST /api/auth/signup          open an account
 *
 * No session: the caller is someone who has no account. That makes this the
 * one door anyone on the internet can push, so it is narrow in every way that
 * costs an honest visitor nothing:
 *
 *   - shut unless the SELF_SIGNUP env is "on" AND the console setting is on;
 *   - a limit per visitor address and a limit per email address;
 *   - a hidden field no person fills in;
 *   - ONE answer for every accepted form, sent before any work is done. A new
 *     address, an address that is already a customer and a bot all read the
 *     same 202 after the same wait, so the form cannot be used to learn who
 *     has an account. What really happened arrives by email, to the owner of
 *     the address and to nobody else.
 */
import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { selfSignupEnvEnabled, selfSignupState, SELF_SIGNUP_DEFAULTS } from "@chatcenter/shared";
import { parseSignupBody, type SignupInput } from "../lib/self-signup-input";
import { runSelfSignup } from "../services/self-signup.service";

/** Forms one visitor address may send in an hour. Refused forms are not counted. */
export const SIGNUP_PER_IP_PER_HOUR = 5;
/** Forms one email address may be named in per day, whoever sends them. */
export const SIGNUP_PER_EMAIL_PER_DAY = 3;

const HOUR_MS = 60 * 60 * 1000;

const disabled = (res: Response): void => {
  res.status(404).json({ error: "signup_disabled" });
};

/**
 * A fresh router with its own counters. The default export is the one the
 * service mounts; tests build their own so one test's forms do not use up
 * another's allowance.
 */
export function buildSignupRouter(): Router {
  const router = Router();

  const perIp = rateLimit({
    windowMs: HOUR_MS,
    limit: SIGNUP_PER_IP_PER_HOUR,
    standardHeaders: true,
    legacyHeaders: false,
    // A form sent back for a typo must not cost the visitor one of five tries.
    skipFailedRequests: true,
    message: { error: "rate_limited" },
  });

  const perEmail = rateLimit({
    windowMs: 24 * HOUR_MS,
    limit: SIGNUP_PER_EMAIL_PER_DAY,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (_req: Request, res: Response) => `email:${(res.locals.signup as SignupInput).email}`,
    message: { error: "rate_limited" },
  });

  router.get("/config", async (_req: Request, res: Response): Promise<void> => {
    try {
      const s = await selfSignupState();
      res.json({ enabled: s.open, trialDays: s.trialDays, cardRequiredAfterDays: s.cardRequiredAfterDays });
    } catch (err) {
      // Unreadable settings read as closed: the page then shows no form, which
      // is the truth of what a POST would meet.
      console.error("[self-signup] config read failed:", (err as Error)?.message);
      res.json({
        enabled: false,
        trialDays: SELF_SIGNUP_DEFAULTS.trialDays,
        cardRequiredAfterDays: SELF_SIGNUP_DEFAULTS.cardRequiredAfterDays,
      });
    }
  });

  /** The env switch first: with it off, not even the limiter's memory is spent. */
  const envGate = (_req: Request, res: Response, next: NextFunction): void => {
    if (!selfSignupEnvEnabled()) return disabled(res);
    next();
  };

  const openGate = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!(await selfSignupState()).open) return disabled(res);
    } catch (err) {
      console.error("[self-signup] state read failed:", (err as Error)?.message);
      return disabled(res);
    }
    next();
  };

  /** Reads the form. A bot and a bad form both end here. */
  const read = (req: Request, res: Response, next: NextFunction): void => {
    const parsed = parseSignupBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: "validation", fields: parsed.fields });
      return;
    }
    if (parsed.honeypot) {
      // The answer a real sign-up gets, and nothing behind it.
      res.status(202).json({ ok: true });
      return;
    }
    res.locals.signup = parsed.value;
    next();
  };

  router.post("/", envGate, perIp, openGate, read, perEmail, (req: Request, res: Response): void => {
    const signup = res.locals.signup as SignupInput;
    const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;

    // Answer first. Everything after this line is invisible to the caller, by
    // design: see the note at the top of the file.
    res.status(202).json({ ok: true });

    // runSelfSignup never rejects; it logs what went wrong.
    void runSelfSignup({ ...signup, ip: req.ip ?? null, userAgent });
  });

  return router;
}

export default buildSignupRouter();
