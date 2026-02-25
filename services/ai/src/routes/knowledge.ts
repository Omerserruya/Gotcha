import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";
import { processDocument } from "../services/embedding.service";
import { deleteByDocumentId, deleteByKnowledgeBaseId } from "../services/qdrant.service";
import { parseFile, isAllowedMimeType, resolveMimeType } from "../services/file-parser.service";
import multer from "multer";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

router.use(authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"));

// List knowledge bases
router.get("/", async (req: Request, res: Response) => {
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
    console.error("List knowledge bases error:", err);
    res.status(500).json({ error: "Failed to list knowledge bases" });
  }
});

// Create knowledge base
router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }

    const kb = await prisma.knowledgeBase.create({
      data: {
        tenantId: req.tenantId!,
        name,
        description: description || null,
      },
    });
    res.status(201).json({ data: kb });
  } catch (err) {
    console.error("Create knowledge base error:", err);
    res.status(500).json({ error: "Failed to create knowledge base" });
  }
});

// Update knowledge base
router.patch("/:id", async (req: Request, res: Response) => {
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
    console.error("Update knowledge base error:", err);
    res.status(500).json({ error: "Failed to update knowledge base" });
  }
});

// Delete knowledge base
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    await deleteByKnowledgeBaseId(kb.id);
    await prisma.knowledgeBase.delete({ where: { id: kb.id } });
    res.json({ data: { deleted: true } });
  } catch (err) {
    console.error("Delete knowledge base error:", err);
    res.status(500).json({ error: "Failed to delete knowledge base" });
  }
});

// Upload document to knowledge base
router.post("/:id/documents", async (req: Request, res: Response) => {
  try {
    const kb = await prisma.knowledgeBase.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId! },
    });
    if (!kb) { res.status(404).json({ error: "Knowledge base not found" }); return; }

    const { title, content, sourceType, sourceUrl } = req.body;
    if (!title || !content) {
      res.status(400).json({ error: "Title and content are required" });
      return;
    }

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
    console.error("Upload document error:", err);
    res.status(500).json({ error: "Failed to upload document" });
  }
});

// Delete document
router.delete("/:id/documents/:docId", async (req: Request, res: Response) => {
  try {
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { id: req.params.docId, knowledgeBaseId: req.params.id, tenantId: req.tenantId! },
    });
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

    await deleteByDocumentId(doc.id);
    await prisma.knowledgeDocument.delete({ where: { id: doc.id } });
    res.json({ data: { deleted: true } });
  } catch (err) {
    console.error("Delete document error:", err);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

// Upload file document to knowledge base
router.post("/:id/documents/upload", upload.single("file"), async (req: Request, res: Response) => {
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

    // Auto-trigger processing
    processDocument(doc.id).catch((err) => {
      console.error(`[Knowledge] Background processing failed for ${doc.id}:`, err.message);
    });

    res.status(201).json({ data: doc });
  } catch (err: any) {
    console.error("File upload error:", err.message);
    res.status(500).json({ error: "Failed to upload file" });
  }
});

// Trigger document processing (embedding generation)
router.post("/:id/documents/:docId/process", async (req: Request, res: Response) => {
  try {
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { id: req.params.docId, knowledgeBaseId: req.params.id, tenantId: req.tenantId! },
    });
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

    // Process async — don't block the request
    processDocument(doc.id).catch((err) => {
      console.error(`[Knowledge] Background processing failed for ${doc.id}:`, err.message);
    });

    res.json({ data: { status: "processing", documentId: doc.id } });
  } catch (err) {
    console.error("Process document error:", err);
    res.status(500).json({ error: "Failed to trigger processing" });
  }
});

export default router;
