import { createServiceApp, startService } from "@chatcenter/shared";
import aiAssistRoutes from "./routes/ai-assist";
import knowledgeRoutes from "./routes/knowledge";
import knowledgeOauthRoutes from "./routes/knowledge-oauth";
import systemChatRoutes from "./routes/system-chat";
import toolRoutes from "./routes/tools";
import integrationRoutes from "./routes/integrations";
import crmOauthRoutes from "./routes/crm-oauth";
import calendarOauthRoutes from "./routes/calendar-oauth";
import schedulerAdminRoutes from "./routes/scheduler-admin";
import funnelAdminRoutes from "./routes/funnel-admin";
import stageAdminRoutes from "./routes/stage-admin";
import actionContractsAdminRoutes from "./routes/action-contracts-admin";
import customApiAdminRoutes from "./routes/custom-api-admin";
import customDbAdminRoutes from "./routes/custom-db-admin";
import connectorsAdminRoutes from "./routes/connectors-admin";
import agentScoreRoutes from "./routes/agent-scores";
import aiAgentRoutes from "./routes/ai-agents";
import aiAgentBuilderRoutes from "./routes/ai-agent-builder";
import aiSkillsRoutes from "./routes/ai-skills";
import routerRuleRoutes from "./routes/router-rules";
import flowCanvasRoutes from "./routes/flow-canvas";
import usageRoutes from "./routes/usage";
import embeddedChatRouter from "./routes/embedded-chat";
import actionPlannerRoutes from "./routes/action-planner";
import toolPermissionRoutes from "./routes/tool-permissions";
import aiDebugRoutes from "./routes/ai-debug";
import aiBotRoutes from "./routes/ai-bot";
import agentLoopResumeRoutes from "./routes/agent-loop-resume";
import agentRoutes from "./routes/agent";
import crmPanelRoutes from "./routes/crm-panel";
import postConversationConfigRoutes from "./routes/post-conversation-config";
import industryPacksRoutes from "./routes/industry-packs";
import fieldDefinitionsRoutes from "./routes/field-definitions";
import intelligenceReviewsRoutes from "./routes/intelligence-reviews";
import customerSnapshotRoutes from "./routes/customer-snapshot";
import crmAutoLinkRoutes from "./routes/crm-auto-link";
import customerSummaryRoutes from "./routes/customer-summary";
import commerceContextRoutes from "./routes/commerce-context";
import copilotOutcomesRoutes from "./routes/copilot-outcomes";
import reasonerShadowRoutes from "./routes/reasoner-shadow";
import decisionTimelineRoutes from "./routes/decision-timeline";
import gdprInternalRoutes from "./routes/gdpr-internal";
import { setProvider } from "./services/ai-assist.service";
import { OpenAIProvider } from "./services/openai.provider";
import { initAIService, getDefaultModel } from "./services/ai.service";
import { startLiveRunnerSupervisor } from "./services/intelligence";
import {
  startPostCallQAWorker,
  startPostCallQATrigger,
  startPostCallAnalyzeWorker,
} from "./workers/post-call";
import postCallRoutes from "./routes/post-call";
// Register all provider adapters at startup. Imports trigger
// registerAdapter() side-effects in each connector file.
import "./services/connectors";

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
  console.log("AI provider: OpenAI initialized (model: %s)", process.env.OPENAI_DEFAULT_MODEL || getDefaultModel());
} else {
  console.warn("AI provider: No OPENAI_API_KEY set - using stub provider");
}

const config = { name: "ai-service", port: parseInt(process.env.PORT || "4006", 10) };
const app = createServiceApp(config);

app.use("/api/ai-assist", aiAssistRoutes);
app.use("/api/knowledge-bases", knowledgeRoutes);
app.use("/api/knowledge", knowledgeOauthRoutes);
app.use("/api/system-chat", systemChatRoutes);
app.use("/api/tools", toolRoutes);
// CRM OAuth (Zoho) must mount BEFORE integrationRoutes - the latter applies
// `authenticate` to its entire router, which would reject Zoho's unauthenticated
// /callback redirect. Public routes here validate a JWT state param instead.
app.use("/api/integrations", crmOauthRoutes);
// Calendar OAuth - same rationale as crmOauthRoutes: callback runs without
// the dashboard's bearer token, so it must mount before integrationRoutes.
app.use("/api/integrations", calendarOauthRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/scheduler", schedulerAdminRoutes);
app.use("/api", funnelAdminRoutes);
app.use("/api", stageAdminRoutes);
app.use("/api", actionContractsAdminRoutes);
app.use("/api", customApiAdminRoutes);
app.use("/api", customDbAdminRoutes);
app.use("/api", connectorsAdminRoutes);
app.use("/api/agent-scores", agentScoreRoutes);
// Mount the builder BEFORE ai-agents so its routes (/builder/*) resolve
// before ai-agents' `GET /:id` could shadow them.
app.use("/api/ai-agents/builder", aiAgentBuilderRoutes);
app.use("/api/ai-agents", aiAgentRoutes);
app.use("/api/ai-skills", aiSkillsRoutes);
app.use("/api/router-rules", routerRuleRoutes);
app.use("/api/flow-canvas", flowCanvasRoutes);
app.use("/api/usage", usageRoutes);
app.use("/api/embedded-chat", embeddedChatRouter);
app.use("/api/action-planner", actionPlannerRoutes);
app.use("/api/tool-permissions", toolPermissionRoutes);
app.use("/api/ai-debug", aiDebugRoutes);
app.use("/api/ai-bot", aiBotRoutes);
app.use("/api/agent-loop", agentLoopResumeRoutes);
app.use("/api/agent", agentRoutes);
app.use("/api/crm", crmPanelRoutes);
app.use("/api/post-conversation-config", postConversationConfigRoutes);
app.use("/api/industry-packs", industryPacksRoutes);
app.use("/api/field-definitions", fieldDefinitionsRoutes);
app.use("/api/intelligence-reviews", intelligenceReviewsRoutes);
app.use("/api/customer-snapshot", customerSnapshotRoutes);
app.use("/api/crm", crmAutoLinkRoutes);
app.use("/api/customer-summary", customerSummaryRoutes);
app.use("/api/commerce-context", commerceContextRoutes);
app.use("/api/reasoner-shadow", reasonerShadowRoutes);
app.use("/api/decision-timeline", decisionTimelineRoutes);
app.use("/api/gdpr-internal", gdprInternalRoutes);
app.use("/api/copilot", copilotOutcomesRoutes);
app.use("/api", postCallRoutes);

// Two voice-copilot pipelines run in parallel:
//   - Phase 3 (legacy): voice-copilot-subscriber → scheduleAssistTrigger
//     → publishEvent("voice.copilot.suggestions"). The chat-shaped
//     suggestions the frontend's "copilot" panel has shown for months.
//   - Phase 4 (new): LiveAnalysisRunner supervisor → publishConvEvent
//     "voice.frame.updated" with structured ConversationStateFrames.
//     Frontend bridges frame.suggestedActions[] into the same panel.
// Both are loaded so the panel keeps working even if Phase 4 has a
// silent failure (LLM error, prompt issue, missing field). Once Phase 4
// is fully verified end-to-end the subscriber can be removed cleanly.
import { startVoiceCopilotSubscriber } from "./services/voice-copilot-subscriber";
import { startVoicePostCallWorker } from "./workers/voice-postcall";
import { startPostChatSubscriber } from "./workers/post-chat/subscriber";
import { startIntelligenceLiveSubscriber } from "./workers/intelligence-live/subscriber";
import { startCommerceCacheSubscriber } from "./services/commerce-cache-subscriber";
startVoiceCopilotSubscriber();
startVoicePostCallWorker();
startPostChatSubscriber();
startIntelligenceLiveSubscriber();
startCommerceCacheSubscriber();
startLiveRunnerSupervisor();

// Voice-flow runner - bridges live-call events into ChatbotFlow rows with
// channel=VOICE so admins manage call automations alongside chat flows.
// See services/ai/src/services/voice-flow/voice-flow-runner.ts.
import { startVoiceFlowRunner } from "./services/voice-flow/voice-flow-runner";
startVoiceFlowRunner();

// Phase 5: Post-Call Mode A QA. Trigger enqueues a QA job on every
// voice.session.ended; worker scores against persisted CallAnalysis.frames,
// writes a QAScore row, emits qa.scored. Independent of the live path -
// can fail without affecting active calls.
startPostCallQAWorker();
startPostCallQATrigger();

// Phase 6: Post-Call Mode B (async analysis). Worker drives the analyze
// queue: drained from POST /api/post-call/analyze submissions. V1 supports
// pasted transcripts via UploadedTranscriptSource; recording-URL ingest
// requires a WhisperClient implementation (Phase 6.x).
startPostCallAnalyzeWorker();

// Knowledge-base auto-sync: hourly background re-sync of connected Google Drive
// / Confluence sources. Change-aware (skips unchanged pages/files) so it only
// re-embeds what actually changed. See services/knowledge-sync.service.ts.
import { startKnowledgeSyncScheduler } from "./services/knowledge-sync.service";
startKnowledgeSyncScheduler();

// Data-retention purge: repeatable BullMQ job (RETENTION_PURGE_CRON, default
// daily 03:30) executing tenant policies + platform env defaults. Without this
// the retention machinery existed but nothing ever invoked it.
import { startRetentionScheduler } from "./services/retention-purge.service";
startRetentionScheduler();

startService(app, config);
export { app };
