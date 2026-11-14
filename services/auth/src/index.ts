import { createServiceApp, startService, seedAllTenantsRbac } from "@chatcenter/shared";
import authRoutes from "./routes/auth";
import setupStateRoutes from "./routes/setup-state";
import sessionAuthRoutes from "./routes/session-auth";
import agentRoutes from "./routes/agents";
import departmentRoutes from "./routes/departments";
import channelRoutes from "./routes/channels";
import whatsappNumberRoutes from "./routes/whatsapp-numbers";
import systemRoutes from "./routes/system";
import systemFeatureRoutes from "./routes/system-features";
import systemManualEditRoutes from "./routes/system-manual-edits";
import supportSessionRoutes from "./routes/support-sessions";
import knowledgeBackfillRoutes from "./routes/knowledge-backfill";
import widgetBrandRoutes from "./routes/widget-brand";
import onboardingRoutes, { publicInviteRouter } from "./routes/onboarding";
import waitlistRoutes from "./routes/waitlist";
import permissionsRoutes from "./routes/permissions";
import accountRoutes from "./routes/account";
import tenantSecurityRoutes from "./routes/tenant-security";
import gdprRoutes from "./routes/gdpr";
import accountDeletionRoutes, { operatorRouter as accountDeletionOperatorRoutes } from "./routes/account-deletion";
import internalRoutes from "./routes/internal";
import setupLinkRoutes from "./routes/setup-link";
import realtimeRoutes from "./routes/realtime";
import agentPresenceRoutes from "./routes/agent-presence";
import { startNudgeWorker } from "./services/nudge-engine.service";
import { startAirtableLeadSync } from "./services/airtable-lead-sync.service";
import { startOnboardingDiscoverWorker } from "./services/onboarding-discover/queue";
import { learnStages } from "./services/onboarding-discover/learn";
import rateLimit from "express-rate-limit";
import { startMfaRequiredFlagSync } from "./services/mfa-required-flag.service";

const config = { name: "auth-service", port: parseInt(process.env.PORT || "4001", 10) };
import workspaceRoutes from "./routes/workspace";
import auditLogRoutes from "./routes/audit-logs";
const app = createServiceApp(config);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/system/login", authLimiter);
app.use("/api/system/seed", authLimiter);

// Rate limit for OAuth endpoints
const oauthLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use("/api/channels/oauth", oauthLimiter);
app.use("/api/channels/connect", oauthLimiter);

// Rate limit for waitlist
app.use("/api/waitlist", authLimiter);

// Routes
// BFF server-side login/callback/logout (migration §A5). Mounted before the
// legacy auth routes; every route 404s unless SESSION_COOKIE_CREATE is on, so
// this is inert by default.
app.use("/api", setupStateRoutes);
app.use("/api", workspaceRoutes);
app.use("/api", auditLogRoutes);
app.use("/api/auth", sessionAuthRoutes);
// Password-setup links. PUBLIC and mounted before the authenticated auth
// routes: the caller is someone who does not have a credential yet, which is
// the whole reason they are here. The token in the URL is the identification.
app.use("/api/auth/setup", setupLinkRoutes);
// Account deletion requests (Google Play / App Store). The public pair needs
// no session; /me is signed in. Before authRoutes, for the same reason as setup.
app.use("/api/auth/account-deletion", accountDeletionRoutes);
app.use("/api/auth", authRoutes);
// BEFORE agentRoutes: that router owns "/:id", and mounting presence after it
// would make /api/agents/presence a lookup for an agent whose id is "presence".
app.use("/api/agents/presence", agentPresenceRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/realtime", realtimeRoutes);
app.use("/api/departments", departmentRoutes);
// Per-number WhatsApp management. Mounted BEFORE the generic channel routes so
// /api/channels/whatsapp/... resolves here rather than falling into
// channelRoutes' "/:id" handlers, which would treat "whatsapp" as a channel id.
app.use("/api/channels/whatsapp", whatsappNumberRoutes);
app.use("/api/channels", channelRoutes);
app.use("/api/system", systemFeatureRoutes);
// Platform operator only: onboarding → Knowledge Base backfill (preview by
// default). Mounted before systemRoutes so its own SYSTEM_ADMIN guard applies.
app.use("/api/system", knowledgeBackfillRoutes);
// Console manual edits: status, login email, no-charge plan/credit changes.
app.use("/api/system", systemManualEditRoutes);
// Support mode: start / current / end (2026-11-01).
app.use("/api/system", supportSessionRoutes);
app.use("/api/system", widgetBrandRoutes);
app.use("/api/system", accountDeletionOperatorRoutes);
app.use("/api/system", systemRoutes);
app.use("/api/permissions", permissionsRoutes);
app.use("/api/account", accountRoutes);
app.use("/api/tenant/security", tenantSecurityRoutes);
app.use("/api/gdpr", gdprRoutes);
app.use("/api/onboarding", onboardingRoutes);
// Public invite endpoints - viewable / acceptable WITHOUT auth so a
// teammate who clicked the link can land on /join, see the tenant
// name, and create their account. Tenant is identified via the
// signed-random token, not the bearer header.
app.use("/api/public/onboarding", publicInviteRouter);
app.use("/api/waitlist", waitlistRoutes);
// Service-to-service only; guarded by X-Internal-Key inside the router.
app.use("/api", internalRoutes);

startService(app, config);

// Option B MFA: keep Authentik's gotcha_mfa_required marker in step with who
// GOTCHA requires MFA of (the login's required-MFA stage keys on it).
startMfaRequiredFlagSync();

// Lifecycle Nudge Engine - repeatable sweep that sends due onboarding nudges.
// Best-effort: a failure here must never stop the auth service from serving.
startNudgeWorker().catch((err) => console.error("[auth] nudge worker start failed:", err?.message));
startAirtableLeadSync();
startOnboardingDiscoverWorker(() => ({ learn: learnStages() }));

// RBAC seed sweep: ensure every tenant has the built-in TenantRole rows +
// legacy-derived assignments (idempotent upserts; custom roles and manual
// assignments are never touched). Without this the Users page role picker is
// empty and fine-grained permission checks have nothing to resolve against.
seedAllTenantsRbac()
  .then((r) => console.log(`[auth] rbac seed: ${r.tenants} tenant(s), ${r.assignments} assignment(s) backfilled`))
  .catch((err) => console.error("[auth] rbac seed failed:", err?.message));

export { app };
