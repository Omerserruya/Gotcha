"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { AppLayout } from "@/components/AppLayout";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getKnowledgeBases,
  createKnowledgeBase,
  deleteKnowledgeBase,
  uploadKnowledgeDocument,
  deleteKnowledgeDocument,
  processKnowledgeDocument,
  uploadKnowledgeFile,
  getKnowledgeIntegrations,
  deleteKnowledgeIntegration,
  initConfluenceOAuth,
  initGoogleDriveOAuth,
  getConfluenceSpaces,
  getConfluencePages,
  syncConfluenceSpaces,
  getDriveFiles,
  syncDriveFiles,
} from "@/lib/api";
import clsx from "clsx";

interface KnowledgeDocument {
  id: string;
  title: string;
  status: string;
  chunkCount: number;
  sourceType: string;
  createdAt: string;
}

interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  documents: KnowledgeDocument[];
  createdAt: string;
}

interface Integration {
  id: string;
  provider: string;
  displayName: string;
  config: any;
  isActive: boolean;
  createdAt: string;
}

export default function KnowledgePage() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedKb, setSelectedKb] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"documents" | "integrations">("documents");

  // Create KB modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newKbName, setNewKbName] = useState("");
  const [newKbDescription, setNewKbDescription] = useState("");
  const [creating, setCreating] = useState(false);

  // Upload doc modal
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadMode, setUploadMode] = useState<"text" | "file">("text");
  const [docTitle, setDocTitle] = useState("");
  const [docContent, setDocContent] = useState("");
  const [docSourceType, setDocSourceType] = useState("text");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Integrations
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [showConnectMenu, setShowConnectMenu] = useState(false);
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);

  // Browse modal (Confluence spaces / Drive files)
  const [showBrowseModal, setShowBrowseModal] = useState(false);
  const [browseIntegration, setBrowseIntegration] = useState<Integration | null>(null);
  const [browseItems, setBrowseItems] = useState<any[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseSelected, setBrowseSelected] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  // Confluence sub-browse: pages within a space
  const [browseSpaceKey, setBrowseSpaceKey] = useState<string | null>(null);
  const [browsePages, setBrowsePages] = useState<any[]>([]);

  const loadKnowledgeBases = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getKnowledgeBases(token);
      setKnowledgeBases(res.data);
    } catch (err) {
      console.error("Failed to load knowledge bases:", err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  const loadIntegrations = useCallback(async () => {
    if (!token || !selectedKb) return;
    try {
      const res = await getKnowledgeIntegrations(token, selectedKb);
      setIntegrations(res.data);
    } catch (err) {
      console.error("Failed to load integrations:", err);
    }
  }, [token, selectedKb]);

  useEffect(() => { loadKnowledgeBases(); }, [loadKnowledgeBases]);
  useEffect(() => { loadIntegrations(); }, [loadIntegrations]);

  // Check for OAuth callback redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (connected) {
      window.history.replaceState({}, "", "/knowledge");
      loadIntegrations();
    }
  }, [loadIntegrations]);

  async function handleCreateKb() {
    if (!token || !newKbName.trim()) return;
    setCreating(true);
    try {
      await createKnowledgeBase(token, { name: newKbName, description: newKbDescription || undefined });
      setShowCreateModal(false);
      setNewKbName("");
      setNewKbDescription("");
      await loadKnowledgeBases();
    } catch (err) {
      console.error("Failed to create KB:", err);
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteKb(kbId: string) {
    if (!token) return;
    try {
      await deleteKnowledgeBase(token, kbId);
      if (selectedKb === kbId) setSelectedKb(null);
      await loadKnowledgeBases();
    } catch (err) {
      console.error("Failed to delete KB:", err);
    }
  }

  async function handleUploadDoc() {
    if (!token || !selectedKb) return;

    if (uploadMode === "file") {
      if (!selectedFile) return;
      setUploading(true);
      try {
        await uploadKnowledgeFile(token, selectedKb, selectedFile, docTitle || selectedFile.name.replace(/\.[^.]+$/, ""));
        setShowUploadModal(false);
        setDocTitle("");
        setSelectedFile(null);
        await loadKnowledgeBases();
      } catch (err) {
        console.error("Failed to upload file:", err);
      } finally {
        setUploading(false);
      }
      return;
    }

    if (!docTitle.trim() || !docContent.trim()) return;
    setUploading(true);
    try {
      const res = await uploadKnowledgeDocument(token, selectedKb, {
        title: docTitle,
        content: docContent,
        sourceType: docSourceType,
      });
      await processKnowledgeDocument(token, selectedKb, res.data.id);
      setShowUploadModal(false);
      setDocTitle("");
      setDocContent("");
      await loadKnowledgeBases();
    } catch (err) {
      console.error("Failed to upload document:", err);
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteDoc(kbId: string, docId: string) {
    if (!token) return;
    try {
      await deleteKnowledgeDocument(token, kbId, docId);
      await loadKnowledgeBases();
    } catch (err) {
      console.error("Failed to delete document:", err);
    }
  }

  async function handleReprocessDoc(kbId: string, docId: string) {
    if (!token) return;
    try {
      await processKnowledgeDocument(token, kbId, docId);
      await loadKnowledgeBases();
    } catch (err) {
      console.error("Failed to reprocess document:", err);
    }
  }

  async function handleConnect(provider: "confluence" | "google_drive") {
    if (!token || !selectedKb) return;
    setConnectingProvider(provider);
    setShowConnectMenu(false);
    try {
      const res = provider === "confluence"
        ? await initConfluenceOAuth(token, selectedKb)
        : await initGoogleDriveOAuth(token, selectedKb);
      window.location.href = res.url;
    } catch (err: any) {
      console.error(`Failed to init ${provider} OAuth:`, err);
      setConnectingProvider(null);
    }
  }

  async function handleDisconnect(intId: string) {
    if (!token) return;
    try {
      await deleteKnowledgeIntegration(token, intId);
      await loadIntegrations();
    } catch (err) {
      console.error("Failed to disconnect:", err);
    }
  }

  async function handleBrowse(integration: Integration) {
    if (!token) return;
    setBrowseIntegration(integration);
    setShowBrowseModal(true);
    setBrowseLoading(true);
    setBrowseSelected(new Set());
    setBrowseSpaceKey(null);
    setBrowsePages([]);
    try {
      if (integration.provider === "confluence") {
        const res = await getConfluenceSpaces(token, integration.id);
        setBrowseItems(res.data);
      } else {
        const res = await getDriveFiles(token, integration.id);
        setBrowseItems(res.data);
      }
    } catch (err) {
      console.error("Failed to browse:", err);
    } finally {
      setBrowseLoading(false);
    }
  }

  async function handleBrowseSpacePages(spaceKey: string) {
    if (!token || !browseIntegration) return;
    setBrowseSpaceKey(spaceKey);
    setBrowseLoading(true);
    try {
      const res = await getConfluencePages(token, browseIntegration.id, spaceKey);
      setBrowsePages(res.data);
    } catch (err) {
      console.error("Failed to load pages:", err);
    } finally {
      setBrowseLoading(false);
    }
  }

  async function handleImportSelected() {
    if (!token || !browseIntegration || browseSelected.size === 0) return;
    setSyncing(true);
    try {
      if (browseIntegration.provider === "confluence") {
        await syncConfluenceSpaces(token, browseIntegration.id, Array.from(browseSelected));
      } else {
        await syncDriveFiles(token, browseIntegration.id, Array.from(browseSelected));
      }
      setShowBrowseModal(false);
      await loadKnowledgeBases();
      await loadIntegrations();
    } catch (err) {
      console.error("Failed to import:", err);
    } finally {
      setSyncing(false);
    }
  }

  function toggleBrowseItem(id: string) {
    setBrowseSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      if (!docTitle) setDocTitle(file.name.replace(/\.[^.]+$/, ""));
    }
  }

  const activeKb = knowledgeBases.find((kb) => kb.id === selectedKb);

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen">
          <div className="w-6 h-6 border-2 border-emerald-200 border-t-emerald-500 rounded-full animate-spin" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-3 md:p-6 overflow-y-auto h-screen">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 md:mb-6">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t("knowledge.title")}</h1>
            <p className="text-sm text-gray-500 mt-1">{t("knowledge.subtitle")}</p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition shadow-sm flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            {t("knowledge.createKb")}
          </button>
        </div>

        <div className="flex gap-6 max-w-6xl">
          {/* Knowledge Base List */}
          <div className="w-72 shrink-0 space-y-2">
            {knowledgeBases.length === 0 ? (
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-8 text-center">
                <div className="w-12 h-12 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                  <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                  </svg>
                </div>
                <p className="text-sm text-gray-500">{t("knowledge.empty")}</p>
              </div>
            ) : (
              knowledgeBases.map((kb) => (
                <button
                  key={kb.id}
                  onClick={() => { setSelectedKb(kb.id); setDetailTab("documents"); }}
                  className={clsx(
                    "w-full text-left p-4 rounded-xl border transition",
                    selectedKb === kb.id
                      ? "bg-emerald-50 border-emerald-200 shadow-sm"
                      : "bg-white border-gray-100 hover:border-gray-200 shadow-card"
                  )}
                >
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="font-semibold text-sm text-gray-900 truncate">{kb.name}</h4>
                    <span className={clsx(
                      "w-2 h-2 rounded-full shrink-0",
                      kb.isActive ? "bg-green-400" : "bg-gray-300"
                    )} />
                  </div>
                  {kb.description && (
                    <p className="text-xs text-gray-400 truncate">{kb.description}</p>
                  )}
                  <p className="text-xs text-gray-400 mt-1">
                    {kb.documents.length} {kb.documents.length === 1 ? "document" : "documents"}
                  </p>
                </button>
              ))
            )}
          </div>

          {/* Knowledge Base Detail */}
          <div className="flex-1 min-w-0">
            {!activeKb ? (
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-12 text-center">
                <svg className="w-12 h-12 text-gray-300 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <p className="text-sm text-gray-400">{t("knowledge.selectKb")}</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* KB Header */}
                <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-bold text-lg text-gray-900">{activeKb.name}</h3>
                      {activeKb.description && (
                        <p className="text-sm text-gray-500 mt-0.5">{activeKb.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setShowUploadModal(true)}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 rounded-lg text-xs font-medium transition flex items-center gap-1.5"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                        </svg>
                        {t("knowledge.addDocument")}
                      </button>

                      {/* Connect Source dropdown */}
                      <div className="relative">
                        <button
                          onClick={() => setShowConnectMenu(!showConnectMenu)}
                          disabled={!!connectingProvider}
                          className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-lg text-xs font-medium transition flex items-center gap-1.5 disabled:opacity-50"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.718a4.5 4.5 0 00-1.242-7.244l4.5-4.5a4.5 4.5 0 016.364 6.364l-1.757 1.757" />
                          </svg>
                          {connectingProvider ? t("knowledge.connecting") : t("knowledge.connectSource")}
                        </button>
                        {showConnectMenu && (
                          <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-10 w-44">
                            <button
                              onClick={() => handleConnect("confluence")}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                            >
                              <span className="w-5 h-5 bg-blue-100 rounded flex items-center justify-center text-blue-600 text-xs font-bold">C</span>
                              {t("knowledge.confluence")}
                            </button>
                            <button
                              onClick={() => handleConnect("google_drive")}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                            >
                              <span className="w-5 h-5 bg-green-100 rounded flex items-center justify-center text-green-600 text-xs font-bold">G</span>
                              {t("knowledge.googleDrive")}
                            </button>
                          </div>
                        )}
                      </div>

                      <button
                        onClick={() => handleDeleteKb(activeKb.id)}
                        className="text-red-400 hover:text-red-600 hover:bg-red-50 p-2 rounded-lg transition"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Tabs: Documents | Integrations */}
                <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
                  <button
                    onClick={() => setDetailTab("documents")}
                    className={clsx(
                      "px-4 py-1.5 rounded-md text-xs font-medium transition",
                      detailTab === "documents" ? "bg-white shadow text-gray-900" : "text-gray-500 hover:text-gray-700"
                    )}
                  >
                    {t("knowledge.documents")} ({activeKb.documents.length})
                  </button>
                  <button
                    onClick={() => setDetailTab("integrations")}
                    className={clsx(
                      "px-4 py-1.5 rounded-md text-xs font-medium transition",
                      detailTab === "integrations" ? "bg-white shadow text-gray-900" : "text-gray-500 hover:text-gray-700"
                    )}
                  >
                    {t("knowledge.integrations")} ({integrations.length})
                  </button>
                </div>

                {/* Documents Tab */}
                {detailTab === "documents" && (
                  <>
                    {activeKb.documents.length === 0 ? (
                      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-8 text-center">
                        <p className="text-sm text-gray-400">{t("knowledge.noDocuments")}</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {activeKb.documents.map((doc) => (
                          <div key={doc.id} className="bg-white rounded-xl shadow-card border border-gray-100 p-4 flex items-center justify-between">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className={clsx(
                                "w-9 h-9 rounded-lg flex items-center justify-center shrink-0",
                                doc.status === "ready" ? "bg-green-100" :
                                doc.status === "processing" ? "bg-amber-100" :
                                doc.status === "error" ? "bg-red-100" : "bg-gray-100"
                              )}>
                                {doc.status === "ready" ? (
                                  <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                  </svg>
                                ) : doc.status === "processing" ? (
                                  <div className="w-4 h-4 border-2 border-amber-300 border-t-amber-600 rounded-full animate-spin" />
                                ) : doc.status === "error" ? (
                                  <svg className="w-4 h-4 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                                  </svg>
                                ) : (
                                  <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                                  </svg>
                                )}
                              </div>
                              <div className="min-w-0">
                                <h5 className="text-sm font-medium text-gray-900 truncate">{doc.title}</h5>
                                <p className="text-xs text-gray-400">
                                  {doc.sourceType} &middot; {doc.chunkCount} chunks &middot;{" "}
                                  <span className={clsx(
                                    doc.status === "ready" ? "text-green-600" :
                                    doc.status === "processing" ? "text-amber-600" :
                                    doc.status === "error" ? "text-red-600" : "text-gray-400"
                                  )}>{doc.status}</span>
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {(doc.status === "error" || doc.status === "pending") && (
                                <button
                                  onClick={() => handleReprocessDoc(activeKb.id, doc.id)}
                                  className="text-emerald-500 hover:text-emerald-700 hover:bg-emerald-50 p-1.5 rounded-lg transition"
                                  title="Process"
                                >
                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
                                  </svg>
                                </button>
                              )}
                              <button
                                onClick={() => handleDeleteDoc(activeKb.id, doc.id)}
                                className="text-red-400 hover:text-red-600 hover:bg-red-50 p-1.5 rounded-lg transition"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* Integrations Tab */}
                {detailTab === "integrations" && (
                  <>
                    {integrations.length === 0 ? (
                      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-8 text-center">
                        <p className="text-sm text-gray-400">{t("knowledge.noIntegrations")}</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {integrations.map((int) => (
                          <div key={int.id} className="bg-white rounded-xl shadow-card border border-gray-100 p-4 flex items-center justify-between">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className={clsx(
                                "w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-xs font-bold",
                                int.provider === "confluence" ? "bg-blue-100 text-blue-600" : "bg-green-100 text-green-600"
                              )}>
                                {int.provider === "confluence" ? "C" : "G"}
                              </div>
                              <div className="min-w-0">
                                <h5 className="text-sm font-medium text-gray-900 truncate">{int.displayName}</h5>
                                <p className="text-xs text-gray-400">
                                  {int.provider === "confluence" ? t("knowledge.confluence") : t("knowledge.googleDrive")}
                                  {int.config?.lastSyncAt && (
                                    <> &middot; {t("knowledge.lastSync")}: {new Date(int.config.lastSyncAt).toLocaleDateString()}</>
                                  )}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                onClick={() => handleBrowse(int)}
                                className="bg-emerald-50 text-emerald-700 hover:bg-emerald-100 px-3 py-1.5 rounded-lg text-xs font-medium transition"
                              >
                                {int.provider === "confluence" ? t("knowledge.browseSpaces") : t("knowledge.browseFiles")}
                              </button>
                              <button
                                onClick={() => handleDisconnect(int.id)}
                                className="text-red-400 hover:text-red-600 hover:bg-red-50 p-1.5 rounded-lg transition"
                                title={t("knowledge.disconnect")}
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Create KB Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h3 className="font-bold text-lg text-gray-900 mb-4">{t("knowledge.createKb")}</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("knowledge.kbName")}</label>
                <input
                  type="text"
                  value={newKbName}
                  onChange={(e) => setNewKbName(e.target.value)}
                  placeholder="e.g. Product Documentation"
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("knowledge.kbDescription")}</label>
                <textarea
                  value={newKbDescription}
                  onChange={(e) => setNewKbDescription(e.target.value)}
                  placeholder="Optional description..."
                  rows={3}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition resize-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition">
                {t("common.cancel")}
              </button>
              <button
                onClick={handleCreateKb}
                disabled={!newKbName.trim() || creating}
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
              >
                {creating ? t("common.saving") : t("common.create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upload Document Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6">
            <h3 className="font-bold text-lg text-gray-900 mb-4">{t("knowledge.addDocument")}</h3>

            {/* Upload Mode Toggle */}
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1 mb-4">
              <button
                onClick={() => setUploadMode("text")}
                className={clsx(
                  "flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition",
                  uploadMode === "text" ? "bg-white shadow text-gray-900" : "text-gray-500 hover:text-gray-700"
                )}
              >
                {t("knowledge.pasteText")}
              </button>
              <button
                onClick={() => setUploadMode("file")}
                className={clsx(
                  "flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition",
                  uploadMode === "file" ? "bg-white shadow text-gray-900" : "text-gray-500 hover:text-gray-700"
                )}
              >
                {t("knowledge.uploadFile")}
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("knowledge.docTitle")}</label>
                <input
                  type="text"
                  value={docTitle}
                  onChange={(e) => setDocTitle(e.target.value)}
                  placeholder="e.g. Return Policy"
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition"
                />
              </div>

              {uploadMode === "text" ? (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t("knowledge.sourceType")}</label>
                    <select
                      value={docSourceType}
                      onChange={(e) => setDocSourceType(e.target.value)}
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition"
                    >
                      <option value="text">Text</option>
                      <option value="url">URL</option>
                      <option value="pdf">PDF</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t("knowledge.content")}</label>
                    <textarea
                      value={docContent}
                      onChange={(e) => setDocContent(e.target.value)}
                      placeholder="Paste document content here..."
                      rows={10}
                      className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300 focus:bg-white outline-none transition resize-none font-mono"
                    />
                  </div>
                </>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t("knowledge.uploadFile")}</label>
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-emerald-400 hover:bg-emerald-50/30 transition"
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.doc,.docx,.md,.txt"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                    {selectedFile ? (
                      <div>
                        <svg className="w-8 h-8 text-emerald-500 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                        </svg>
                        <p className="text-sm font-medium text-gray-900">{selectedFile.name}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{(selectedFile.size / 1024).toFixed(1)} KB</p>
                      </div>
                    ) : (
                      <div>
                        <svg className="w-8 h-8 text-gray-400 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                        </svg>
                        <p className="text-sm text-gray-500">Click to select a file</p>
                        <p className="text-xs text-gray-400 mt-1">{t("knowledge.supportedFormats")}</p>
                        <p className="text-xs text-gray-400">{t("knowledge.maxFileSize")}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => { setShowUploadModal(false); setSelectedFile(null); setUploadMode("text"); }} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition">
                {t("common.cancel")}
              </button>
              <button
                onClick={handleUploadDoc}
                disabled={uploading || (uploadMode === "text" ? (!docTitle.trim() || !docContent.trim()) : !selectedFile)}
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
              >
                {uploading ? t("common.saving") : t("knowledge.upload")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Browse Modal (Confluence Spaces / Drive Files) */}
      {showBrowseModal && browseIntegration && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-lg text-gray-900">
                {browseSpaceKey ? (
                  <button onClick={() => { setBrowseSpaceKey(null); setBrowsePages([]); setBrowseSelected(new Set()); }} className="text-emerald-600 hover:text-emerald-700 mr-2">
                    &larr;
                  </button>
                ) : null}
                {browseIntegration.provider === "confluence"
                  ? browseSpaceKey ? `Pages in ${browseSpaceKey}` : t("knowledge.browseSpaces")
                  : t("knowledge.browseFiles")
                }
              </h3>
              <button onClick={() => setShowBrowseModal(false)} className="text-gray-400 hover:text-gray-600 p-1">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-1">
              {browseLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-6 h-6 border-2 border-emerald-200 border-t-emerald-500 rounded-full animate-spin" />
                </div>
              ) : browseIntegration.provider === "confluence" && !browseSpaceKey ? (
                // Confluence spaces list
                browseItems.map((space: any) => (
                  <div key={space.key} className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 cursor-pointer" onClick={() => {
                    toggleBrowseItem(space.key);
                  }}>
                    <input
                      type="checkbox"
                      checked={browseSelected.has(space.key)}
                      onChange={() => toggleBrowseItem(space.key)}
                      className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900">{space.name}</p>
                      <p className="text-xs text-gray-400">{space.key}</p>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleBrowseSpacePages(space.key); }}
                      className="text-xs text-emerald-600 hover:text-emerald-700"
                    >
                      View pages &rarr;
                    </button>
                  </div>
                ))
              ) : browseIntegration.provider === "confluence" && browseSpaceKey ? (
                // Confluence pages in a space
                browsePages.map((page: any) => (
                  <div key={page.id} className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50">
                    <div className="w-7 h-7 bg-blue-50 rounded flex items-center justify-center shrink-0">
                      <svg className="w-3.5 h-3.5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                      </svg>
                    </div>
                    <p className="text-sm text-gray-900 truncate">{page.title}</p>
                  </div>
                ))
              ) : (
                // Drive files list
                browseItems.map((file: any) => (
                  <div key={file.id} className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 cursor-pointer" onClick={() => toggleBrowseItem(file.id)}>
                    <input
                      type="checkbox"
                      checked={browseSelected.has(file.id)}
                      onChange={() => toggleBrowseItem(file.id)}
                      className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    <div className={clsx(
                      "w-7 h-7 rounded flex items-center justify-center shrink-0 text-xs font-bold",
                      file.mimeType === "application/vnd.google-apps.folder" ? "bg-amber-50 text-amber-600" : "bg-green-50 text-green-600"
                    )}>
                      {file.mimeType === "application/vnd.google-apps.folder" ? (
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                        </svg>
                      )}
                    </div>
                    <p className="text-sm text-gray-900 truncate">{file.name}</p>
                  </div>
                ))
              )}
            </div>

            {browseSelected.size > 0 && !browseSpaceKey && (
              <div className="mt-4 pt-4 border-t border-gray-100 flex items-center justify-between">
                <p className="text-xs text-gray-500">{browseSelected.size} selected</p>
                <button
                  onClick={handleImportSelected}
                  disabled={syncing}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {syncing ? t("knowledge.syncing") : t("knowledge.importSelected")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </AppLayout>
  );
}
