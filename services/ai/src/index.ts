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
import flowCanvasRoutes from "./routes/flow-canvas";
import usageRoutes from "./routes/usage";
import embeddedChatRouter from "./routes/embedded-chat";
import actionPlannerRoutes from "./routes/action-planner";
import { setProvider } from "./services/ai-assist.service";
import { OpenAIProvider } from "./services/openai.provider";
import { initAIService } from "./services/ai.service";

// Initialize central AI service (MUST be done before provider)
if (process.env.OPENAI_API_KEY) {
  initAIService({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    defaultModel: process.env.OPENAI_DEFAULT_MODEL || undefined,
    defaultEmbeddingModel: process.env.EMBEDDING_MODEL || undefined,
  });

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
app.use("/api/flow-canvas", flowCanvasRoutes);
app.use("/api/usage", usageRoutes);
app.use("/api/embedded-chat", embeddedChatRouter);
app.use("/api/action-planner", actionPlannerRoutes);

startService(app, config);
export { app };
