import { createServiceApp, startService } from "@chatcenter/shared";
import analyticsRoutes from "./routes/analytics";
import { startAnalyticsWorker } from "./workers/analytics.worker";

const config = { name: "analytics-service", port: parseInt(process.env.PORT || "4004", 10) };
const app = createServiceApp(config);

app.use("/api/analytics", analyticsRoutes);

// Start analytics worker (consumes analytics-aggregation queue)
startAnalyticsWorker();

startService(app, config);
export { app };
