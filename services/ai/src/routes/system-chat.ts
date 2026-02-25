import { Router, Request, Response } from "express";
import { prisma, authenticate, requireSystemAdmin } from "@chatcenter/shared";
import { processDocument } from "../services/embedding.service";
import { deleteByDocumentId } from "../services/qdrant.service";
import { parseFile, isAllowedMimeType, resolveMimeType } from "../services/file-parser.service";
import { retrieveRelevantChunks, buildKnowledgeContext } from "../services/knowledge.service";
import OpenAI from "openai";
import multer from "multer";

const router = Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CHAT_MODEL = process.env.OPENAI_DEFAULT_MODEL || "gpt-4o-mini";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.use(authenticate, requireSystemAdmin());

// ─── Knowledge Base CRUD ────────────────────────────────────

router.get("/knowledge-bases", async (req: Request, res: Response) => {
  try {
    const knowledgeBases = await prisma.knowledgeBase.findMany({
      where: { tenantId: req.tenantId! },
      include: {
        documents: {
          select: { id: true, title: true, status: true, chunkCount: true, sourceType: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: knowledgeBases });
  } catch (err) {
    console.error("[SystemChat] List KB error:", err);
    res.status(500).json({ error: "Failed to list knowledge bases" });
  }
});

router.post("/knowledge-bases", async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;
    if (!name) { res.status(400).json({ error: "Name is required" }); return; }

    const kb = await prisma.knowledgeBase.create({
      data: { tenantId: req.tenantId!, name, description: description || null },
    });
    res.status(201).json({ data: kb });
  } catch (err) {
    console.error("[SystemChat] Create KB error:", err);
    res.status(500).json({ error: "Failed to create knowledge base" });
  }
});

router.patch("/knowledge-bases/:id", async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    const { name, description, isActive } = req.body;
    const updated = await prisma.knowledgeBase.update({
      where: { id: kb.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
    });
    res.json({ data: updated });
  } catch (err) {
    console.error("[SystemChat] Update KB error:", err);
    res.status(500).json({ error: "Failed to update knowledge base" });
  }
});

router.delete("/knowledge-bases/:id", async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    res.json({ data: { deleted: true } });
  } catch (err) {
    console.error("[SystemChat] Delete KB error:", err);
    res.status(500).json({ error: "Failed to delete knowledge base" });
  }
});

// ─── Document Management ────────────────────────────────────

router.post("/knowledge-bases/:id/documents", async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    const { title, content, sourceType, sourceUrl } = req.body;
    if (!title || !content) { res.status(400).json({ error: "Title and content are required" }); return; }

    const doc = await prisma.knowledgeDocument.create({
      data: {
        knowledgeBaseId: kb.id,
        tenantId: req.tenantId!,
        title,
        content,
        sourceType: sourceType || "text",
        sourceUrl: sourceUrl || null,
        status: "pending",
      },
    });
    res.status(201).json({ data: doc });
  } catch (err) {
    console.error("[SystemChat] Upload document error:", err);
    res.status(500).json({ error: "Failed to upload document" });
  }
});

router.post("/knowledge-bases/:id/documents/upload", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    const file = req.file;
    if (!file) { res.status(400).json({ error: "File is required" }); return; }

    const mime = resolveMimeType(file.mimetype, file.originalname);
    if (!isAllowedMimeType(mime)) {
      res.status(400).json({ error: "Unsupported file type. Allowed: PDF, DOCX, DOC, MD, TXT" });
      return;
    }

    const title = (req.body.title as string) || file.originalname.replace(/\.[^.]+$/, "");
    const content = await parseFile(file.buffer, mime);

    if (!content.trim()) {
      res.status(400).json({ error: "Could not extract text from file" });
      return;
    }

    const doc = await prisma.knowledgeDocument.create({
      data: {
        knowledgeBaseId: kb.id,
        tenantId: req.tenantId!,
        title,
        content,
        sourceType: "file",
        status: "pending",
        metadata: {
          originalFilename: file.originalname,
          mimeType: file.mimetype,
          fileSize: file.size,
        },
      },
    });

    processDocument(doc.id).catch((err) => {
      console.error(`[SystemChat] Background processing failed for ${doc.id}:`, err.message);
    });

    res.status(201).json({ data: doc });
  } catch (err: any) {
    console.error("[SystemChat] File upload error:", err.message);
    res.status(500).json({ error: "Failed to upload file" });
  }
});

router.delete("/knowledge-bases/:id/documents/:docId", async (req: Request, res: Response) => {
  try {
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { id: req.params.docId, knowledgeBaseId: req.params.id, tenantId: req.tenantId! },
    });
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

    await deleteByDocumentId(doc.id);
    await prisma.knowledgeDocument.delete({ where: { id: doc.id } });
    res.json({ data: { deleted: true } });
  } catch (err) {
    console.error("[SystemChat] Delete document error:", err);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

router.post("/knowledge-bases/:id/documents/:docId/process", async (req: Request, res: Response) => {
  try {
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { id: req.params.docId, knowledgeBaseId: req.params.id, tenantId: req.tenantId! },
    });
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

    processDocument(doc.id).catch((err) => {
      console.error(`[SystemChat] Background processing failed for ${doc.id}:`, err.message);
    });

    res.json({ data: { status: "processing", documentId: doc.id } });
  } catch (err) {
    console.error("[SystemChat] Process document error:", err);
    res.status(500).json({ error: "Failed to trigger processing" });
  }
});

// ─── Chat (RAG) ─────────────────────────────────────────────

router.post("/ask", async (req: Request, res: Response) => {
  try {
    const { question, history } = req.body;
    if (!question) { res.status(400).json({ error: "Question is required" }); return; }

    const chunks = await retrieveRelevantChunks(req.tenantId!, question, 5);
    const knowledgeContext = buildKnowledgeContext(chunks);

    const systemPrompt = `You are an AI assistant for the system administrator of a multi-tenant customer support platform called GOTCHA.
Answer questions based on the provided knowledge base context. Be accurate, concise, and helpful.
If the knowledge base context does not contain relevant information to answer the question, say so honestly rather than making up an answer.
${knowledgeContext ? `\n${knowledgeContext}` : "\nNo knowledge base documents are available. Let the user know they can upload documents to get contextual answers."}`;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    if (Array.isArray(history)) {
      for (const msg of history) {
        if (msg.role === "user" || msg.role === "assistant") {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    messages.push({ role: "user", content: question });

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 1024,
    });

    const answer = completion.choices[0]?.message?.content || "I was unable to generate a response.";

    const sources = chunks
      .filter((c) => c.score > 0.3)
      .map((c) => ({ documentTitle: c.documentTitle, score: Math.round(c.score * 100) / 100 }));

    res.json({ answer, sources });
  } catch (err: any) {
    console.error("[SystemChat] Ask error:", err.message);
    res.status(500).json({ error: "Failed to generate answer" });
  }
});

export default router;
