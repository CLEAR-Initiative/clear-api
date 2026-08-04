/**
 * REST endpoint for uploading a WhatsApp chat export into the ground
 * staging tier.
 *
 * POST /api/ground/upload  (multipart/form-data)
 *   - `groundSourceId` (text field): the groundSources row this export
 *     belongs to. Uploads are rejected for unknown/inactive sources —
 *     the per-source policy record is the consent gate.
 *   - `chat` (file field): the export's `_chat.txt`.
 *
 * Callers: admin/analyst only (session or API key) — the staging tier is
 * private, so the viewer role has no access. Response reports created vs
 * skipped counts; re-uploading the same export is idempotent and creates
 * zero duplicates (deterministic externalIds + unique constraint).
 *
 * Precedent: routes/upload.ts (multipart handling, auth resolution,
 * multer error mapping).
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { prisma } from "../lib/prisma.js";
import { resolveRequestAuth } from "../utils/request-auth.js";
import { ingestWhatsAppExport } from "../services/ground-ingest.js";

const router = Router();

// Chat .txt files are small; 20 MB leaves room for very large groups.
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const GROUND_UPLOAD_ROLES = new Set(["admin", "analyst"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

function uploadFields(req: Request, res: Response, next: NextFunction): void {
  upload.fields([{ name: "chat", maxCount: 1 }])(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "File exceeds the 20 MB limit" });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : "Upload error" });
      return;
    }
    next();
  });
}

router.post("/", uploadFields, async (req, res) => {
  try {
    const { user } = await resolveRequestAuth(req.headers);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!GROUND_UPLOAD_ROLES.has(user.role ?? "")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const groundSourceId = typeof req.body?.groundSourceId === "string" ? req.body.groundSourceId : "";
    if (!groundSourceId) {
      res.status(400).json({ error: "groundSourceId is required" });
      return;
    }

    const source = await prisma.groundSources.findUnique({ where: { id: groundSourceId } });
    if (!source || !source.isActive) {
      res.status(404).json({ error: "Ground source not found or inactive" });
      return;
    }

    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const chatFile = files?.chat?.[0];
    if (!chatFile) {
      res.status(400).json({ error: "A chat export file is required (field \"chat\")" });
      return;
    }

    const result = await ingestWhatsAppExport({
      db: prisma,
      groundSourceId: source.id,
      groupJid: source.transportId,
      exportText: chatFile.buffer.toString("utf-8"),
    });

    res.json(result);
  } catch (err) {
    console.error("[ground-upload] Failed:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

export { router as groundUploadRouter };
