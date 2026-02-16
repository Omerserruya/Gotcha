import { createServiceApp, startService } from "@chatcenter/shared";
import chatbotRoutes from "./routes/chatbot";

const config = { name: "chatbot-service", port: parseInt(process.env.PORT || "4005", 10) };
const app = createServiceApp(config);

app.use("/api/chatbot-flows", chatbotRoutes);

startService(app, config);
export { app };
