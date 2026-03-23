import { createServiceApp, startService } from "@chatcenter/shared";
import aiAssistRoutes from "./routes/ai-assist";
import knowledgeRoutes from "./routes/knowledge";
import knowledgeOauthRoutes from "./routes/knowledge-oauth";
import systemChatRoutes from "./routes/system-chat";
import toolRoutes from "./routes/tools";
import integrationRoutes from "./routes/integrations";
import agentScoreRoutes from "./routes/agent-scores";
import aiAgentRoutes from "./routes/ai-agents";
import routerRuleRoutes from "./routes/router-rules";
import { setProvider } from "./services/ai-assist.service";
import { OpenAIProvider } from "./services/openai.provider";

// Initialize AI provider from env
if (process.env.OPENAI_API_KEY) {
  setProvider(new OpenAIProvider(
    process.env.OPENAI_API_KEY,
    process.env.OPENAI_BASE_URL || undefined,
    process.env.OPENAI_DEFAULT_MODEL || undefined,
  ));
  console.log("AI provider: OpenAI initialized (model: %s)", process.env.OPENAI_DEFAULT_MODEL || "gpt-4o-mini");
} else {
  console.warn("AI provider: No OPENAI_API_KEY set — using stub provider");
}

const config = { name: "ai-service", port: parseInt(process.env.PORT || "4006", 10) };
const app = createServiceApp(config);

app.use("/api/ai-assist", aiAssistRoutes);
app.use("/api/knowledge-bases", knowledgeRoutes);
app.use("/api/knowledge", knowledgeOauthRoutes);
app.use("/api/system-chat", systemChatRoutes);
app.use("/api/tools", toolRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/agent-scores", agentScoreRoutes);
app.use("/api/ai-agents", aiAgentRoutes);
app.use("/api/router-rules", routerRuleRoutes);

startService(app, config);
export { app };
