import { createServiceApp, startService } from "@chatcenter/shared";
import chatbotRoutes from "./routes/chatbot";
import automationRoutes from "./routes/automations";

const config = { name: "chatbot-service", port: parseInt(process.env.PORT || "4005", 10) };
const app = createServiceApp(config);

app.use("/api/chatbot-flows", chatbotRoutes);
app.use("/api/automations", automationRoutes);

startService(app, config);
export { app };
