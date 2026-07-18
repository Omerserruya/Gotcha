import { createServiceApp, startService, seedAllTenantsRbac } from "@chatcenter/shared";
import authRoutes from "./routes/auth";
import agentRoutes from "./routes/agents";
import departmentRoutes from "./routes/departments";
import channelRoutes from "./routes/channels";
import systemRoutes from "./routes/system";
import systemFeatureRoutes from "./routes/system-features";
import onboardingRoutes, { publicInviteRouter } from "./routes/onboarding";
import waitlistRoutes from "./routes/waitlist";
import permissionsRoutes from "./routes/permissions";
import accountRoutes from "./routes/account";
import tenantSecurityRoutes from "./routes/tenant-security";
import gdprRoutes from "./routes/gdpr";
import { startNudgeWorker } from "./services/nudge-engine.service";
import rateLimit from "express-rate-limit";

const config = { name: "auth-service", port: parseInt(process.env.PORT || "4001", 10) };
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
app.use("/api/auth", authRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/departments", departmentRoutes);
app.use("/api/channels", channelRoutes);
app.use("/api/system", systemFeatureRoutes);
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

startService(app, config);

// Lifecycle Nudge Engine - repeatable sweep that sends due onboarding nudges.
// Best-effort: a failure here must never stop the auth service from serving.
startNudgeWorker().catch((err) => console.error("[auth] nudge worker start failed:", err?.message));

// RBAC seed sweep: ensure every tenant has the built-in TenantRole rows +
// legacy-derived assignments (idempotent upserts; custom roles and manual
// assignments are never touched). Without this the Users page role picker is
// empty and fine-grained permission checks have nothing to resolve against.
seedAllTenantsRbac()
  .then((r) => console.log(`[auth] rbac seed: ${r.tenants} tenant(s), ${r.assignments} assignment(s) backfilled`))
  .catch((err) => console.error("[auth] rbac seed failed:", err?.message));

export { app };
