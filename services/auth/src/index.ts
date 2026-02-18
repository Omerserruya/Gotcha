import { createServiceApp, startService } from "@chatcenter/shared";
import authRoutes from "./routes/auth";
import agentRoutes from "./routes/agents";
import departmentRoutes from "./routes/departments";
import rateLimit from "express-rate-limit";

const config = { name: "auth-service", port: parseInt(process.env.PORT || "4001", 10) };
const app = createServiceApp(config);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/departments", departmentRoutes);

startService(app, config);
export { app };
