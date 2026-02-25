"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  getSystemKnowledgeBases,
  createSystemKnowledgeBase,
  deleteSystemKnowledgeBase,
  uploadSystemDocument,
  uploadSystemFile,
  processSystemDocument,
  deleteSystemDocument,
  askSystemChat,
  getTokenUsage,
} from "@/lib/api";
import { SystemLayout } from "@/components/SystemLayout";
import ReactMarkdown from "react-markdown";
import clsx from "clsx";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: { documentTitle: string; score: number }[];
}

interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  documents: DocItem[];
}

interface DocItem {
  id: string;
  title: string;
  status: string;
  chunkCount: number | null;
  sourceType: string;
  createdAt: string;
}

export default function SystemChatPage() {
  const { token } = useAuth();

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [thinking, setThinking] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // KB state
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [selectedKbId, setSelectedKbId] = useState<string | null>(null);
  const [kbLoading, setKbLoading] = useState(true);

  // Token usage
  const [tokenCount, setTokenCount] = useState(0);

  // Toast
  const [toast, setToast] = useState<{ message: string; type: "error" | "success" } | null>(null);
  const showToast = (message: string, type: "error" | "success" = "error") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Modals
  const [showCreateKb, setShowCreateKb] = useState(false);
  const [newKbName, setNewKbName] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [uploadTab, setUploadTab] = useState<"text" | "file">("text");
  const [docTitle, setDocTitle] = useState("");
  const [docContent, setDocContent] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const selectedKb = knowledgeBases.find((kb) => kb.id === selectedKbId) || null;

  // Load KBs
  const loadKBs = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getSystemKnowledgeBases(token);
      setKnowledgeBases(res.data);
    } catch (err) {
      console.error("Failed to load KBs:", err);
    } finally {
      setKbLoading(false);
    }
  }, [token]);

  useEffect(() => { loadKBs(); }, [loadKBs]);

  // Load token usage
  const loadTokenUsage = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getTokenUsage(token);
      setTokenCount(res.totals.totalTokens);
    } catch {
      // silently ignore
    }
  }, [token]);

  useEffect(() => { loadTokenUsage(); }, [loadTokenUsage]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  // Create KB
  const handleCreateKb = async () => {
    if (!token || !newKbName.trim()) return;
    try {
      const res = await createSystemKnowledgeBase(token, { name: newKbName.trim() });
      setKnowledgeBases((prev) => [{ ...res.data, documents: res.data.documents || [] }, ...prev]);
      setSelectedKbId(res.data.id);
      setNewKbName("");
      setShowCreateKb(false);
    } catch (err) {
      console.error("Failed to create KB:", err);
    }
  };

  // Delete KB
  const handleDeleteKb = async (id: string) => {
    if (!token || !confirm("Delete this knowledge base and all its documents?")) return;
    try {
      await deleteSystemKnowledgeBase(token, id);
      setKnowledgeBases((prev) => prev.filter((kb) => kb.id !== id));
      if (selectedKbId === id) setSelectedKbId(null);
    } catch (err) {
      console.error("Failed to delete KB:", err);
    }
  };

  // Upload document
  const handleUploadDoc = async () => {
    if (!token || !selectedKbId) return;
    setUploading(true);
    try {
      if (uploadTab === "text") {
        if (!docTitle.trim() || !docContent.trim()) return;
        await uploadSystemDocument(token, selectedKbId, { title: docTitle.trim(), content: docContent.trim() });
      } else {
        if (!selectedFile) return;
        const title = docTitle.trim() || selectedFile.name.replace(/\.[^.]+$/, "");
        await uploadSystemFile(token, selectedKbId, selectedFile, title);
      }
      await loadKBs();
      setShowUpload(false);
      setDocTitle("");
      setDocContent("");
      setSelectedFile(null);
    } catch (err: any) {
      showToast(err.message || "Upload failed", "error");
    } finally {
      setUploading(false);
    }
  };

  // Process document
  const handleProcess = async (kbId: string, docId: string) => {
    if (!token) return;
    try {
      await processSystemDocument(token, kbId, docId);
      // Optimistically update status
      setKnowledgeBases((prev) =>
        prev.map((kb) =>
          kb.id === kbId
            ? { ...kb, documents: kb.documents.map((d) => (d.id === docId ? { ...d, status: "processing" } : d)) }
            : kb
        )
      );
      // Refresh after delay
      setTimeout(loadKBs, 3000);
    } catch (err) {
      console.error("Failed to process:", err);
    }
  };

  // Delete document
  const handleDeleteDoc = async (kbId: string, docId: string) => {
    if (!token || !confirm("Delete this document?")) return;
    try {
      await deleteSystemDocument(token, kbId, docId);
      setKnowledgeBases((prev) =>
        prev.map((kb) =>
          kb.id === kbId ? { ...kb, documents: kb.documents.filter((d) => d.id !== docId) } : kb
        )
      );
    } catch (err) {
      console.error("Failed to delete doc:", err);
    }
  };

  // Send chat message
  const handleSend = async () => {
    if (!token || !question.trim() || thinking) return;
    const q = question.trim();
    setQuestion("");
    setMessages((prev) => [...prev, { role: "user", content: q }]);
    setThinking(true);

    try {
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      const res = await askSystemChat(token, { question: q, history });
      setMessages((prev) => [...prev, { role: "assistant", content: res.answer, sources: res.sources }]);
      loadTokenUsage();
    } catch (err) {
      setMessages((prev) => [...prev, { role: "assistant", content: "Sorry, an error occurred. Please try again." }]);
    } finally {
      setThinking(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <SystemLayout>
      <div className="flex h-full overflow-hidden">
        {/* Left panel - KB management */}
        <div className="hidden md:flex w-80 border-e border-gray-200 bg-white flex-col shrink-0 overflow-hidden">
          <div className="p-4 border-b border-gray-100">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold text-gray-900">Knowledge Base</h2>
              <button
                onClick={() => setShowCreateKb(true)}
                className="text-xs font-medium text-orange-600 hover:text-orange-700"
              >
                + New KB
              </button>
            </div>
            <p className="text-xs text-gray-400">Upload docs for RAG-powered answers</p>
          </div>

          {/* Create KB inline form */}
          {showCreateKb && (
            <div className="p-3 border-b border-gray-100 bg-orange-50/50">
              <input
                type="text"
                value={newKbName}
                onChange={(e) => setNewKbName(e.target.value)}
                placeholder="Knowledge base name..."
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-2 focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-400"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleCreateKb()}
              />
              <div className="flex gap-2">
                <button
                  onClick={handleCreateKb}
                  disabled={!newKbName.trim()}
                  className="flex-1 text-xs font-medium bg-orange-500 text-white rounded-lg py-1.5 hover:bg-orange-600 disabled:opacity-50 transition"
                >
                  Create
                </button>
                <button
                  onClick={() => { setShowCreateKb(false); setNewKbName(""); }}
                  className="flex-1 text-xs font-medium text-gray-500 bg-gray-100 rounded-lg py-1.5 hover:bg-gray-200 transition"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* KB List */}
          <div className="flex-1 overflow-y-auto">
            {kbLoading ? (
              <div className="p-4 text-center text-sm text-gray-400">Loading...</div>
            ) : knowledgeBases.length === 0 ? (
              <div className="p-4 text-center text-sm text-gray-400">No knowledge bases yet</div>
            ) : (
              knowledgeBases.map((kb) => (
                <div key={kb.id}>
                  <button
                    onClick={() => setSelectedKbId(selectedKbId === kb.id ? null : kb.id)}
                    className={clsx(
                      "w-full text-start px-4 py-3 border-b border-gray-50 transition hover:bg-gray-50",
                      selectedKbId === kb.id && "bg-orange-50"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-900 truncate">{kb.name}</span>
                      <span className="text-[10px] text-gray-400">{kb.documents.length} docs</span>
                    </div>
                  </button>

                  {/* Expanded KB - show docs */}
                  {selectedKbId === kb.id && (
                    <div className="bg-gray-50/50 border-b border-gray-100">
                      <div className="px-4 py-2 flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-500">Documents</span>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setShowUpload(true)}
                            className="text-[10px] font-medium text-orange-600 hover:text-orange-700"
                          >
                            + Add
                          </button>
                          <button
                            onClick={() => handleDeleteKb(kb.id)}
                            className="text-[10px] font-medium text-red-400 hover:text-red-600"
                          >
                            Delete KB
                          </button>
                        </div>
                      </div>
                      {kb.documents.length === 0 ? (
                        <div className="px-4 pb-3 text-xs text-gray-400">No documents</div>
                      ) : (
                        kb.documents.map((doc) => (
                          <div key={doc.id} className="px-4 py-2 flex items-center justify-between group">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-gray-700 truncate">{doc.title}</p>
                              <div className="flex items-center gap-2 mt-0.5">
                                <StatusBadge status={doc.status} />
                                {doc.chunkCount && (
                                  <span className="text-[10px] text-gray-400">{doc.chunkCount} chunks</span>
                                )}
                              </div>
                            </div>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition">
                              {(doc.status === "pending" || doc.status === "error") && (
                                <button
                                  onClick={() => handleProcess(kb.id, doc.id)}
                                  className="text-[10px] text-orange-500 hover:text-orange-700 px-1"
                                  title="Process"
                                >
                                  Process
                                </button>
                              )}
                              <button
                                onClick={() => handleDeleteDoc(kb.id, doc.id)}
                                className="text-[10px] text-red-400 hover:text-red-600 px-1"
                                title="Delete"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right panel - Chat */}
        <div className="flex-1 flex flex-col bg-gray-50 min-w-0 overflow-hidden">
          {/* Chat header */}
          <div className="bg-white border-b border-gray-200 px-4 md:px-6 py-3 flex items-center justify-between shrink-0">
            <div>
              <h1 className="text-base font-semibold text-gray-900">AI Chat</h1>
              <p className="text-xs text-gray-400">Ask questions against your knowledge base</p>
            </div>
            <div className="flex items-center gap-3">
              {tokenCount > 0 && (
                <span className="text-[10px] font-medium text-gray-400 bg-gray-100 rounded-full px-2.5 py-1">
                  {tokenCount.toLocaleString()} tokens used
                </span>
              )}
              {messages.length > 0 && (
                <button
                  onClick={() => setMessages([])}
                  className="text-xs font-medium text-gray-400 hover:text-gray-600 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition"
                >
                  Clear Chat
                </button>
              )}
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 space-y-4">
            {messages.length === 0 && !thinking ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center max-w-md">
                  <div className="w-16 h-16 mx-auto mb-4 bg-orange-100 rounded-2xl flex items-center justify-center">
                    <svg className="w-8 h-8 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">System Admin AI Chat</h3>
                  <p className="text-sm text-gray-500">
                    Ask questions to get AI-powered answers from your knowledge base.
                    Upload documents in the sidebar to enable contextual responses.
                  </p>
                </div>
              </div>
            ) : (
              <>
                {messages.map((msg, i) => (
                  <div key={i} className={clsx("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                    <div
                      className={clsx(
                        "max-w-[80%] rounded-2xl px-4 py-3",
                        msg.role === "user"
                          ? "bg-orange-500 text-white"
                          : "bg-white border border-gray-200 text-gray-800"
                      )}
                    >
                      {msg.role === "assistant" ? (
                        <div className="text-sm prose prose-sm prose-gray max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2 prose-pre:bg-gray-50 prose-pre:rounded-lg prose-code:text-orange-600 prose-code:before:content-none prose-code:after:content-none">
                          <ReactMarkdown>{msg.content}</ReactMarkdown>
                        </div>
                      ) : (
                        <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                      )}
                      {msg.sources && msg.sources.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-gray-100">
                          <p className="text-[10px] font-medium text-gray-400 mb-1">Sources</p>
                          <div className="flex flex-wrap gap-1">
                            {msg.sources.map((src, j) => (
                              <span
                                key={j}
                                className="inline-flex items-center text-[10px] bg-orange-50 text-orange-600 rounded-full px-2 py-0.5"
                              >
                                {src.documentTitle}
                                <span className="ml-1 text-orange-400">{Math.round(src.score * 100)}%</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {thinking && (
                  <div className="flex justify-start">
                    <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex gap-1">
                          <span className="w-2 h-2 bg-orange-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                          <span className="w-2 h-2 bg-orange-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                          <span className="w-2 h-2 bg-orange-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                        </div>
                        <span className="text-xs text-gray-400">Thinking...</span>
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Input bar */}
          <div className="bg-white border-t border-gray-200 px-4 md:px-6 py-3 shrink-0">
            <div className="flex items-end gap-3">
              {/* Mobile KB button */}
              <button
                onClick={() => {
                  const el = document.getElementById("mobile-kb-sheet");
                  if (el) el.classList.toggle("hidden");
                }}
                className="md:hidden shrink-0 w-10 h-10 bg-orange-50 text-orange-500 rounded-xl flex items-center justify-center"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                </svg>
              </button>
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask a question..."
                rows={1}
                className="flex-1 resize-none border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-400"
              />
              <button
                onClick={handleSend}
                disabled={!question.trim() || thinking}
                className="shrink-0 w-10 h-10 bg-orange-500 text-white rounded-xl flex items-center justify-center hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Upload modal */}
      {showUpload && selectedKb && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowUpload(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-gray-100">
              <h3 className="text-base font-semibold text-gray-900">Add Document</h3>
              <p className="text-xs text-gray-400 mt-0.5">to {selectedKb.name}</p>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-100">
              <button
                onClick={() => setUploadTab("text")}
                className={clsx(
                  "flex-1 py-2.5 text-sm font-medium transition",
                  uploadTab === "text" ? "text-orange-600 border-b-2 border-orange-500" : "text-gray-400"
                )}
              >
                Paste Text
              </button>
              <button
                onClick={() => setUploadTab("file")}
                className={clsx(
                  "flex-1 py-2.5 text-sm font-medium transition",
                  uploadTab === "file" ? "text-orange-600 border-b-2 border-orange-500" : "text-gray-400"
                )}
              >
                Upload File
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Title</label>
                <input
                  type="text"
                  value={docTitle}
                  onChange={(e) => setDocTitle(e.target.value)}
                  placeholder="Document title..."
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-400"
                />
              </div>

              {uploadTab === "text" ? (
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Content</label>
                  <textarea
                    value={docContent}
                    onChange={(e) => setDocContent(e.target.value)}
                    placeholder="Paste document content..."
                    rows={8}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-400 resize-none"
                  />
                </div>
              ) : (
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">File</label>
                  <input
                    type="file"
                    accept=".pdf,.docx,.doc,.md,.txt"
                    onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                    className="w-full text-sm file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-orange-50 file:text-orange-600 hover:file:bg-orange-100"
                  />
                  <p className="text-[10px] text-gray-400 mt-1">PDF, DOCX, DOC, MD, TXT (max 10MB)</p>
                </div>
              )}
            </div>

            <div className="p-5 border-t border-gray-100 flex justify-end gap-3">
              <button
                onClick={() => { setShowUpload(false); setDocTitle(""); setDocContent(""); setSelectedFile(null); }}
                className="text-sm text-gray-500 px-4 py-2 rounded-lg hover:bg-gray-100 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleUploadDoc}
                disabled={uploading || (uploadTab === "text" ? !docTitle.trim() || !docContent.trim() : !selectedFile)}
                className="text-sm font-medium bg-orange-500 text-white px-4 py-2 rounded-lg hover:bg-orange-600 disabled:opacity-50 transition"
              >
                {uploading ? "Uploading..." : "Upload"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Toast notification */}
      {toast && (
        <div className={clsx(
          "fixed top-4 right-4 z-[60] px-4 py-3 rounded-xl shadow-lg text-sm font-medium transition-all animate-in slide-in-from-top-2 duration-300",
          toast.type === "error" ? "bg-red-500 text-white" : "bg-green-500 text-white"
        )}>
          <div className="flex items-center gap-2">
            {toast.type === "error" ? (
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            ) : (
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <span>{toast.message}</span>
            <button onClick={() => setToast(null)} className="ml-2 opacity-70 hover:opacity-100">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </SystemLayout>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { bg: string; text: string; label: string }> = {
    ready: { bg: "bg-green-100", text: "text-green-700", label: "Ready" },
    processing: { bg: "bg-yellow-100", text: "text-yellow-700", label: "Processing" },
    pending: { bg: "bg-gray-100", text: "text-gray-600", label: "Pending" },
    error: { bg: "bg-red-100", text: "text-red-700", label: "Error" },
  };
  const c = config[status] || config.pending;
  return (
    <span className={clsx("text-[10px] font-medium px-1.5 py-0.5 rounded-full", c.bg, c.text)}>
      {c.label}
    </span>
  );
}
