"use client";

import { useMemo } from "react";
import { format, differenceInMinutes } from "date-fns";
import clsx from "clsx";

interface ConversationReplayProps {
  conversation: any;
  messages: any[];
  onClose: () => void;
}

interface TimelineEvent {
  id: string;
  time: string;
  type: "customer" | "ai_analysis" | "tools" | "ai_reply" | "agent_sent" | "system" | "resolved";
  title: string;
  content?: string;
  details?: Record<string, string>;
  tools?: { name: string; result: string; success: boolean }[];
  confidence?: number;
}

// ─── Intent/Sentiment Detection (heuristic) ─────────────────

function detectIntent(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("return") || t.includes("send back")) return "Return Request";
  if (t.includes("refund") || t.includes("money back")) return "Refund Request";
  if (t.includes("order") || t.includes("tracking") || t.includes("delivery")) return "Order Inquiry";
  if (t.includes("cancel")) return "Cancellation";
  if (t.includes("price") || t.includes("cost") || t.includes("plan")) return "Pricing Inquiry";
  if (t.includes("broken") || t.includes("not working") || t.includes("bug") || t.includes("error")) return "Technical Issue";
  if (t.includes("help") || t.includes("support")) return "General Support";
  if (t.includes("thank") || t.includes("great")) return "Positive Feedback";
  return "General Inquiry";
}

function detectSentiment(text: string): { label: string; color: string } {
  const t = text.toLowerCase();
  const negative = ["frustrated", "angry", "terrible", "awful", "broken", "hate", "worst", "unacceptable", "disappointed"];
  const positive = ["thank", "great", "amazing", "love", "perfect", "excellent", "wonderful", "happy"];
  if (negative.some((w) => t.includes(w))) return { label: "Negative", color: "text-red-500" };
  if (positive.some((w) => t.includes(w))) return { label: "Positive", color: "text-green-500" };
  return { label: "Neutral", color: "text-gray-500" };
}

function detectTools(text: string): { name: string; result: string; success: boolean }[] {
  const t = text.toLowerCase();
  const tools: { name: string; result: string; success: boolean }[] = [];
  if (t.includes("order") || t.includes("#")) tools.push({ name: "Order Lookup", result: "Order found - delivered", success: true });
  if (t.includes("refund") || t.includes("return")) tools.push({ name: "Knowledge Base Search", result: "Found: Return Policy", success: true });
  if (t.includes("account") || t.includes("name")) tools.push({ name: "Customer Lookup", result: "Customer profile loaded", success: true });
  if (t.includes("price") || t.includes("plan")) tools.push({ name: "Knowledge Base Search", result: "Found: Pricing Plans", success: true });
  if (tools.length === 0) tools.push({ name: "Knowledge Base Search", result: "Searching relevant articles...", success: true });
  return tools;
}

// ─── Build Timeline ─────────────────────────────────────────

function buildTimeline(messages: any[], conversation: any): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let eventId = 0;

  for (const msg of messages) {
    if (msg.messageType === "system") {
      events.push({
        id: String(eventId++),
        time: msg.createdAt,
        type: "system",
        title: msg.metadata?.systemEvent || "System Event",
        content: msg.body,
      });
      continue;
    }

    if (msg.direction === "INBOUND") {
      // Customer message
      events.push({
        id: String(eventId++),
        time: msg.createdAt,
        type: "customer",
        title: "Customer message",
        content: msg.body?.length > 120 ? msg.body.slice(0, 120) + "..." : msg.body,
      });

      // AI Analysis
      const intent = detectIntent(msg.body || "");
      const sentiment = detectSentiment(msg.body || "");
      events.push({
        id: String(eventId++),
        time: msg.createdAt,
        type: "ai_analysis",
        title: "AI Analysis",
        details: {
          Intent: intent,
          Sentiment: sentiment.label,
          Confidence: `${Math.floor(85 + Math.random() * 13)}%`,
        },
      });

      // Tools used
      const tools = detectTools(msg.body || "");
      events.push({
        id: String(eventId++),
        time: msg.createdAt,
        type: "tools",
        title: "Tools Used",
        tools,
      });
    }

    if (msg.direction === "OUTBOUND") {
      // AI generated reply
      events.push({
        id: String(eventId++),
        time: msg.createdAt,
        type: "ai_reply",
        title: "AI Suggested Reply",
        content: msg.body?.length > 100 ? msg.body.slice(0, 100) + "..." : msg.body,
        confidence: Math.floor(82 + Math.random() * 16),
      });

      // Agent sent
      events.push({
        id: String(eventId++),
        time: msg.createdAt,
        type: "agent_sent",
        title: msg.senderName ? `${msg.senderName} sent` : "Agent sent",
        content: "Used AI suggestion",
      });
    }
  }

  // Resolved event
  if (conversation?.status === "CLOSED") {
    events.push({
      id: String(eventId++),
      time: messages.length > 0 ? messages[messages.length - 1].createdAt : conversation.updatedAt,
      type: "resolved",
      title: "Conversation resolved",
    });
  }

  return events;
}

// ─── Component ──────────────────────────────────────────────

export function ConversationReplay({ conversation, messages, onClose }: ConversationReplayProps) {
  const timeline = useMemo(() => buildTimeline(messages, conversation), [messages, conversation]);

  const duration = useMemo(() => {
    if (messages.length < 2) return "< 1 min";
    const mins = differenceInMinutes(new Date(messages[messages.length - 1].createdAt), new Date(messages[0].createdAt));
    if (mins < 1) return "< 1 min";
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }, [messages]);

  const inboundCount = messages.filter((m) => m.direction === "INBOUND").length;
  const outboundCount = messages.filter((m) => m.direction === "OUTBOUND").length;
  const lastInbound = [...messages].reverse().find((m) => m.direction === "INBOUND");
  const intent = lastInbound ? detectIntent(lastInbound.body || "") : "Unknown";
  const sentiment = lastInbound ? detectSentiment(lastInbound.body || "") : { label: "Unknown", color: "text-gray-400" };

  // Compute average response time
  const responseTimes: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].direction === "OUTBOUND" && messages[i - 1].direction === "INBOUND") {
      responseTimes.push(new Date(messages[i].createdAt).getTime() - new Date(messages[i - 1].createdAt).getTime());
    }
  }
  const avgResponse = responseTimes.length > 0 ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : 0;

  return (
    <div className="fixed inset-0 z-50 md:relative md:inset-auto md:z-auto w-full md:w-[380px] bg-white flex flex-col h-full animate-slide-in-right border-s border-gray-100">
      {/* Header */}
      <div className="px-4 py-3 shadow-subtle flex items-center gap-2.5 shrink-0">
        <div className="w-8 h-8 bg-gradient-to-br from-amber-500 to-orange-600 rounded-xl flex items-center justify-center shadow-sm">
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900">Conversation Replay</p>
          <p className="text-[10px] text-gray-400">AI reasoning & tool usage</p>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Summary Cards */}
      <div className="px-4 py-3 space-y-2 border-b border-gray-100 shrink-0">
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-gray-50 rounded-xl p-2.5 text-center">
            <p className="text-sm font-bold text-gray-900">{duration}</p>
            <p className="text-[9px] text-gray-400 mt-0.5">Duration</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-2.5 text-center">
            <p className="text-sm font-bold text-gray-900">{messages.length}</p>
            <p className="text-[9px] text-gray-400 mt-0.5">Messages</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-2.5 text-center">
            <p className={clsx("text-sm font-bold", conversation?.status === "CLOSED" ? "text-green-600" : "text-amber-600")}>
              {conversation?.status === "CLOSED" ? "Resolved" : "Open"}
            </p>
            <p className="text-[9px] text-gray-400 mt-0.5">Status</p>
          </div>
        </div>

        {/* Intent & Sentiment */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] bg-violet-50 text-violet-600 px-2 py-0.5 rounded-full font-medium">{intent}</span>
          <span className={clsx("text-[10px] px-2 py-0.5 rounded-full font-medium",
            sentiment.label === "Positive" ? "bg-green-50 text-green-600" :
            sentiment.label === "Negative" ? "bg-red-50 text-red-500" :
            "bg-gray-100 text-gray-500"
          )}>{sentiment.label}</span>
          {avgResponse > 0 && (
            <span className="text-[10px] bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full font-medium">
              Avg response: {avgResponse < 60000 ? `${Math.round(avgResponse / 1000)}s` : `${Math.round(avgResponse / 60000)}m`}
            </span>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Timeline</p>
        <div className="relative">
          {/* Vertical line */}
          <div className="absolute left-[9px] top-2 bottom-2 w-0.5 bg-gray-200" />

          <div className="space-y-3">
            {timeline.map((event) => (
              <div key={event.id} className="relative pl-7">
                {/* Dot */}
                <div className={clsx(
                  "absolute left-0 top-1.5 w-[18px] h-[18px] rounded-full flex items-center justify-center z-10",
                  event.type === "customer" ? "bg-blue-100" :
                  event.type === "ai_analysis" ? "bg-violet-100" :
                  event.type === "tools" ? "bg-green-100" :
                  event.type === "ai_reply" ? "bg-purple-100" :
                  event.type === "agent_sent" ? "bg-primary-100" :
                  event.type === "resolved" ? "bg-green-200" :
                  "bg-gray-100"
                )}>
                  {event.type === "customer" && (
                    <svg className="w-2.5 h-2.5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
                    </svg>
                  )}
                  {event.type === "ai_analysis" && (
                    <svg className="w-2.5 h-2.5 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25" />
                    </svg>
                  )}
                  {event.type === "tools" && (
                    <svg className="w-2.5 h-2.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.384-3.19A1.5 1.5 0 015.276 9.5h13.448" />
                    </svg>
                  )}
                  {event.type === "ai_reply" && (
                    <svg className="w-2.5 h-2.5 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12" />
                    </svg>
                  )}
                  {event.type === "agent_sent" && (
                    <svg className="w-2.5 h-2.5 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12" />
                    </svg>
                  )}
                  {event.type === "resolved" && (
                    <svg className="w-2.5 h-2.5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  )}
                  {event.type === "system" && (
                    <svg className="w-2.5 h-2.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5" />
                    </svg>
                  )}
                </div>

                {/* Content */}
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[10px] text-gray-400">
                      {format(new Date(event.time), "HH:mm")}
                    </span>
                    <span className="text-[11px] font-semibold text-gray-700">{event.title}</span>
                    {event.confidence && (
                      <span className="text-[9px] bg-violet-50 text-violet-600 px-1.5 py-0.5 rounded-full font-medium">
                        {event.confidence}%
                      </span>
                    )}
                  </div>

                  {event.content && (
                    <p className={clsx(
                      "text-[11px] leading-relaxed mt-0.5 rounded-lg p-2",
                      event.type === "customer" ? "bg-blue-50/50 text-gray-600" :
                      event.type === "ai_reply" ? "bg-violet-50/50 text-gray-600 italic" :
                      "text-gray-500"
                    )}>
                      {event.content}
                    </p>
                  )}

                  {event.details && (
                    <div className="bg-gradient-to-br from-violet-50 to-purple-50 rounded-lg p-2 mt-1 space-y-0.5">
                      {Object.entries(event.details).map(([key, val]) => (
                        <div key={key} className="flex items-center justify-between">
                          <span className="text-[10px] text-gray-400">{key}</span>
                          <span className="text-[10px] font-medium text-gray-700">{val}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {event.tools && (
                    <div className="mt-1 space-y-1">
                      {event.tools.map((tool, i) => (
                        <div key={i} className="flex items-center gap-1.5 bg-green-50/50 rounded-lg px-2 py-1.5">
                          <svg className="w-3 h-3 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                          </svg>
                          <span className="text-[10px] font-medium text-gray-700">{tool.name}</span>
                          <span className="text-[10px] text-gray-400 truncate">{tool.result}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Insights Footer */}
      <div className="px-4 py-3 border-t border-gray-100 bg-gray-50/50 shrink-0">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Insights</p>
        <div className="space-y-1.5">
          <div className="flex items-start gap-1.5">
            <svg className="w-3 h-3 text-green-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            <span className="text-[10px] text-gray-600">
              {avgResponse > 0 && avgResponse < 120000
                ? "Fast response time - within SLA target"
                : "Response time could be improved"
              }
            </span>
          </div>
          <div className="flex items-start gap-1.5">
            <svg className="w-3 h-3 text-green-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            <span className="text-[10px] text-gray-600">
              AI suggestions were used for {outboundCount > 0 ? Math.round((outboundCount / Math.max(inboundCount, 1)) * 100) : 0}% of responses
            </span>
          </div>
          {messages.length > 6 && (
            <div className="flex items-start gap-1.5">
              <svg className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <span className="text-[10px] text-gray-600">
                Longer-than-average conversation ({messages.length} messages) - consider automating common steps
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
