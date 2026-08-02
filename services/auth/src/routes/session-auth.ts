import { Router, Request, Response } from "express";
import {
  prisma,
  readSessionFlags,
  verifyIdToken,
  parseSessionCookie,
  serializeClearedSessionCookie,
  resolveSessionCookieContract,
  hashSessionToken,
  REVOCATION_REASON,
} from "@chatcenter/shared";
import {
  oidcConfig,
  discover,
  generatePkce,
  randomState,
  randomNonce,
  buildAuthorizeUrl,
  exchangeCode,
  safeReturnTo,
} from "../lib/oidc-server";
import { buildSessionRecord, chooseActiveMembership } from "../lib/session-factory";

/**
 * BFF server-side login (migration §A5). Moves the browser's PKCE exchange to
 * the backend: the verifier lives in OidcLoginState, tokens are exchanged
 * server-side and sealed into a UserSession, and the browser only ever receives
 * the opaque `__Host-gotcha_session` cookie.
 *
 * ENTIRELY GATED by SESSION_COOKIE_CREATE. With the flag off (default) every
 * route 404s, so existing browser-Bearer auth is untouched. No token, code or
 * verifier is ever logged.
 */
const router = Router();

const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;

function appOrigin(): string {
  return (process.env.APP_ORIGIN || "").replace(/\/$/, "");
}

/** Gate: 404 unless cookie-session creation is enabled. */
function ensureEnabled(res: Response): boolean {
  if (!readSessionFlags(process.env).cookieCreate) {
    res.status(404).json({ error: "Not found" });
    return false;
  }
  return true;
}

// GET /api/auth/login → start the server-side Authorization-Code + PKCE flow.
router.get("/login", async (req: Request, res: Response): Promise<void> => {
  if (!ensureEnabled(res)) return;
  try {
    const cfg = oidcConfig();
    const disco = await discover(cfg);
    const { verifier, challenge } = generatePkce();
    const state = randomState();
    const nonce = randomNonce();
    const returnTo = safeReturnTo(req.query.next ?? req.query.returnTo);
    const rememberMe = req.query.remember === "true" || req.query.remember === "1";

    await prisma.oidcLoginState.create({
      data: {
        state,
        nonce,
        codeVerifier: verifier,
        returnTo,
        rememberMe,
        expiresAt: new Date(Date.now() + LOGIN_STATE_TTL_MS),
      },
    });

    const loginHint = typeof req.query.login_hint === "string" ? req.query.login_hint : undefined;
    res.redirect(302, buildAuthorizeUrl(disco, cfg, { state, nonce, challenge, loginHint }));
  } catch (err) {
    console.error("[session-auth] login start failed"); // no secrets
    res.redirect(302, `${appOrigin()}/login?error=login_failed`);
  }
});

// GET /api/auth/callback → complete the flow, create the session, set the cookie.
router.get("/callback", async (req: Request, res: Response): Promise<void> => {
  if (!ensureEnabled(res)) return;
  const idpError = typeof req.query.error === "string" ? req.query.error : null;
  if (idpError) {
    res.redirect(302, `${appOrigin()}/login?error=${encodeURIComponent(idpError)}`);
    return;
  }
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  if (!code || !state) {
    // Nothing usable → restart a clean login once.
    res.redirect(302, "/api/auth/login");
    return;
  }

  try {
    // Single-use: atomically consume the login-state. A missing/expired/used
    // state is not an error state for the user (e.g. a reset-in-a-new-tab
    // replay) - restart a clean login.
    const ls = await prisma.oidcLoginState.findUnique({ where: { state } });
    if (!ls || ls.consumedAt || ls.expiresAt.getTime() < Date.now()) {
      res.redirect(302, "/api/auth/login");
      return;
    }
    await prisma.oidcLoginState.update({ where: { id: ls.id }, data: { consumedAt: new Date() } });

    const cfg = oidcConfig();
    const disco = await discover(cfg);
    const tokens = await exchangeCode(disco, cfg, { code, verifier: ls.codeVerifier });
    const verified = await verifyIdToken(tokens.id_token, { nonce: ls.nonce, clientId: cfg.clientId });

    const identity = await prisma.identity.findUnique({
      where: { authentikSubject: verified.subject },
      select: {
        id: true,
        sessionVersion: true,
        lastTenantId: true,
        memberships: { select: { id: true, tenantId: true, isActive: true } },
      },
    });
    if (!identity || identity.memberships.every((m) => !m.isActive)) {
      res.redirect(302, `${appOrigin()}/login?error=no_account`);
      return;
    }

    const activeMembershipId = chooseActiveMembership(identity.memberships, identity.lastTenantId ?? null);

    const { setCookie, createData } = buildSessionRecord({
      tokens,
      identityId: identity.id,
      identitySessionVersion: identity.sessionVersion,
      activeMembershipId,
      rememberMe: ls.rememberMe,
      userAgent: req.headers["user-agent"] ?? null,
      ip: req.ip ?? null,
    });
    await prisma.userSession.create({ data: createData as any });

    res.setHeader("Set-Cookie", setCookie);
    // Same-origin relative redirect (returnTo is validated relative).
    res.redirect(302, `${appOrigin()}${ls.returnTo}`);
  } catch (err) {
    console.error("[session-auth] callback failed"); // never log code/token/verifier
    res.redirect(302, `${appOrigin()}/login?error=signin_failed`);
  }
});

// POST /api/auth/logout → revoke the current session + clear the cookie.
// (Minimal here; logout-all / session-list / IdP end-session are commit 9.)
router.post("/logout", async (req: Request, res: Response): Promise<void> => {
  if (!ensureEnabled(res)) return;
  try {
    const contract = resolveSessionCookieContract(process.env);
    const raw = parseSessionCookie(req.headers.cookie, contract.name);
    if (raw) {
      const sessionTokenHash = hashSessionToken(raw);
      await prisma.userSession.updateMany({
        where: { sessionTokenHash, revokedAt: null },
        data: { revokedAt: new Date(), revocationReason: REVOCATION_REASON.LOGOUT },
      });
    }
  } catch {
    // Even if revocation fails, still clear the browser cookie below.
  }
  res.setHeader("Set-Cookie", serializeClearedSessionCookie(process.env));
  res.json({ ok: true });
});

export default router;
