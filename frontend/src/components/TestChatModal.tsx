"use client";

import { useState, useRef, useEffect } from "react";
import clsx from "clsx";

interface TestChatModalProps {
  isOpen: boolean;
  onClose: () => void;
  agentId: string;
  agentName: string;
  avatarColor: string;
  token: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export default function TestChatModal({ isOpen, onClose, agentId, agentName, avatarColor, token }: TestChatModalProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  useEffect(() => {
    if (isOpen) {
      setMessages([{
        id: "welcome",
        role: "assistant",
        content: `Hi! I'm ${agentName}. Send me a message to test how I'll respond to customers.`,
        timestamp: new Date(),
      }]);
      setInput("");
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, agentName]);

  async function handleSend() {
    const text = input.trim();
    if (!text || thinking) return;

    const userMsg: ChatMessage = { id: `u_${Date.now()}`, role: "user", content: text, timestamp: new Date() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setThinking(true);

    try {
      const { testAgentChat } = await import("@/lib/api");
      const history = newMessages
        .filter(m => m.id !== "welcome")
        .map(m => ({ role: m.role, content: m.content }));
      const res = await testAgentChat(token, agentId, text, history);
      const reply = res.data?.reply || "No response generated.";
      setMessages(prev => [...prev, {
        id: `a_${Date.now()}`,
        role: "assistant",
        content: reply,
        timestamp: new Date(),
      }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        id: `err_${Date.now()}`,
        role: "assistant",
        content: "Error: Failed to get response. Make sure the agent is configured correctly.",
        timestamp: new Date(),
      }]);
    } finally {
      setThinking(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg h-[600px] max-h-[85vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-scale-in">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3 shrink-0">
          <div className={clsx("w-9 h-9 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-sm font-bold", avatarColor)}>
            {(agentName || "A").charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900 text-sm">{agentName}</h3>
            <p className="text-[11px] text-gray-400">Test Mode - Autonomous</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-600 border border-amber-200">
              Sandbox
            </span>
            <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 bg-gray-50/50">
          {messages.map(msg => (
            <div key={msg.id} className={clsx("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
              <div className={clsx(
                "max-w-[80%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap",
                msg.role === "user"
                  ? "bg-violet-600 text-white rounded-br-md"
                  : "bg-white text-gray-800 border border-gray-100 rounded-bl-md shadow-sm"
              )}>
                {msg.content}
              </div>
            </div>
          ))}
          {thinking && (
            <div className="flex justify-start">
              <div className="bg-white border border-gray-100 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
                <div className="flex gap-1.5">
                  <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Input */}
        <div className="px-4 py-3 border-t border-gray-100 bg-white shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              rows={1}
              className="flex-1 resize-none px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition max-h-24"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || thinking}
              className="w-10 h-10 rounded-xl bg-violet-600 text-white flex items-center justify-center hover:bg-violet-700 transition disabled:opacity-40 shrink-0"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
