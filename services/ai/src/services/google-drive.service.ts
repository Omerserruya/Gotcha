import { prisma } from "@chatcenter/shared";
import { parseFile } from "./file-parser.service";
import { processDocument } from "./embedding.service";

interface DriveIntegration {
  id: string;
  credentials: {
    accessToken: string;
    refreshToken: string;
    expiresAt?: number;
  };
  knowledgeBaseId: string;
  tenantId: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

async function driveFetch(integration: DriveIntegration, url: string): Promise<Response> {
  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${integration.credentials.accessToken}` },
  });

  if (res.status === 401) {
    const newToken = await refreshDriveToken(integration);
    if (newToken) {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${newToken}` },
      });
    }
  }

  return res;
}

async function refreshDriveToken(integration: DriveIntegration): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: integration.credentials.refreshToken,
    }),
  });

  if (!res.ok) return null;

  const data: any = await res.json();
  const newCredentials = {
    ...integration.credentials,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  await prisma.knowledgeIntegration.update({
    where: { id: integration.id },
    data: { credentials: newCredentials as any },
  });

  integration.credentials = newCredentials;
  return data.access_token;
}

export async function listFiles(
  integration: DriveIntegration,
  folderId?: string
): Promise<DriveFile[]> {
  let query = "trashed=false and (mimeType='application/vnd.google-apps.document' or mimeType='application/pdf' or mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType='text/plain' or mimeType='text/markdown' or mimeType='application/vnd.google-apps.folder')";

  if (folderId) {
    query = `'${folderId}' in parents and ${query}`;
  }

  const params = new URLSearchParams({
    q: query,
    fields: "files(id,name,mimeType)",
    pageSize: "100",
  });

  const res = await driveFetch(
    integration,
    `https://www.googleapis.com/drive/v3/files?${params}`
  );

  if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
  const data: any = await res.json();
  return (data.files || []).map((f: any) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
  }));
}

export async function fetchFileContent(
  integration: DriveIntegration,
  fileId: string,
  mimeType: string
): Promise<string> {
  // Google Docs: export as plain text
  if (mimeType === "application/vnd.google-apps.document") {
    const res = await driveFetch(
      integration,
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`
    );
    if (!res.ok) throw new Error(`Drive export error: ${res.status}`);
    return (await res.text()).trim();
  }

  // Binary files: download and parse
  const res = await driveFetch(
    integration,
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
  );
  if (!res.ok) throw new Error(`Drive download error: ${res.status}`);

  if (mimeType === "text/plain" || mimeType === "text/markdown") {
    return (await res.text()).trim();
  }

  // PDF / DOCX: parse via file-parser
  const buffer = Buffer.from(await res.arrayBuffer());
  return parseFile(buffer, mimeType);
}

export async function syncFiles(
  integration: DriveIntegration,
  fileIds: string[]
): Promise<{ imported: number }> {
  let imported = 0;

  // Get file metadata for all requested files
  for (const fileId of fileIds) {
    try {
      const metaRes = await driveFetch(
        integration,
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType`
      );
      if (!metaRes.ok) continue;
      const fileMeta: any = await metaRes.json();

      // Skip folders — recurse into them
      if (fileMeta.mimeType === "application/vnd.google-apps.folder") {
        const children = await listFiles(integration, fileId);
        const childIds = children
          .filter((c: DriveFile) => c.mimeType !== "application/vnd.google-apps.folder")
          .map((c: DriveFile) => c.id);
        if (childIds.length > 0) {
          const sub = await syncFiles(integration, childIds);
          imported += sub.imported;
        }
        continue;
      }

      const content = await fetchFileContent(integration, fileId, fileMeta.mimeType);
      if (!content) continue;

      const doc = await prisma.knowledgeDocument.create({
        data: {
          knowledgeBaseId: integration.knowledgeBaseId,
          tenantId: integration.tenantId,
          title: fileMeta.name,
          content,
          sourceType: "google_drive",
          sourceUrl: `https://drive.google.com/file/d/${fileId}`,
          status: "pending",
          metadata: {
            integrationId: integration.id,
            driveFileId: fileId,
            mimeType: fileMeta.mimeType,
          },
        },
      });

      processDocument(doc.id).catch((err) => {
        console.error(`[GoogleDrive] Failed to process file ${fileId}:`, err.message);
      });
      imported++;
    } catch (err: any) {
      console.error(`[GoogleDrive] Failed to import file ${fileId}:`, err.message);
    }
  }

  // Update last sync time
  await prisma.knowledgeIntegration.update({
    where: { id: integration.id },
    data: {
      config: {
        ...(integration as any).config,
        lastSyncAt: new Date().toISOString(),
      },
    },
  });

  return { imported };
}
