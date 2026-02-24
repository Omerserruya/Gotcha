import { createServiceApp, startService } from "@chatcenter/shared";
import authRoutes from "./routes/auth";
import agentRoutes from "./routes/agents";
import departmentRoutes from "./routes/departments";
import channelRoutes from "./routes/channels";
import systemRoutes from "./routes/system";
import onboardingRoutes from "./routes/onboarding";
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

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/departments", departmentRoutes);
app.use("/api/channels", channelRoutes);
app.use("/api/system", systemRoutes);
app.use("/api/onboarding", onboardingRoutes);

startService(app, config);
export { app };
