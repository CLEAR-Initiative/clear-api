/**
 * REST endpoint for LIVE gateway media byte upload into the ground
 * staging tier.
 *
 * POST /api/ground/media  (multipart/form-data)
 *   - `file` (file field, required): the media bytes. The part's filename
 *     supplies the S3 key extension; its content-type is stored as the
 *     object's ContentType.
 *   - `groupJid` OR `groundSourceId` (text field, exactly one): which
 *     ground source the media belongs to. `groupJid` (the WhatsApp group
 *     JID / groundSources transportId) is the gateway's native handle —
 *     its ingest payloads are JID-keyed; `groundSourceId` serves
 *     admin/manual callers who hold the row id.
 *   - `sourceMessageExternalId` (text field, optional): the message the
 *     media belongs to, scheme "whatsapp:{groupJid}:{messageId}" (same as
 *     ingest). See services/ground-media.ts for attach semantics.
 *
 * Bytes are stored to S3 under the content-hash scheme
 * `ground/{sourceId}/{sha256}.{ext}` (same as export upload), so
 * identical bytes never duplicate objects. Response returns the key as
 * JSON; the gateway includes it as a mediaKey in its ingest payload.
 *
 * Auth: machine callers only — pipeline-role API key, the same mechanism
 * as /api/ground/ingest. Platform admins also pass, for manual testing.
 *
 * CONSENT GATE (hard, same as ingest): the source must be an ACTIVE
 * groundSources row whose recorded consent covers message-content
 * capture. Unknown or unconsented → 403, NOTHING stored, rejection
 * logged.
 *
 * Limits mirror the export upload route: 50 MB per file.
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { prisma } from "../lib/prisma.js";
import { resolveRequestAuth } from "../utils/request-auth.js";
import { storeGroundMedia } from "../services/ground-media.js";
import { uploadBufferToS3 } from "../services/s3.js";

const router = Router();

// 50 MB — matches /api/ground/upload and /api/upload.
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const GROUND_MEDIA_ROLES = new Set(["admin", "pipeline"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

function uploadSingle(req: Request, res: Response, next: NextFunction): void {
  upload.single("file")(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "File exceeds the 50 MB limit" });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : "Upload error" });
      return;
    }
    next();
  });
}

router.post("/", uploadSingle, async (req, res) => {
  try {
    const { user } = await resolveRequestAuth(req.headers);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!GROUND_MEDIA_ROLES.has(user.role ?? "")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const groundSourceId = typeof body.groundSourceId === "string" ? body.groundSourceId : "";
    const groupJid = typeof body.groupJid === "string" ? body.groupJid : "";
    if ((groundSourceId === "") === (groupJid === "")) {
      res.status(400).json({
        error: "Exactly one of groundSourceId or groupJid is required",
      });
      return;
    }
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "A media file is required (field \"file\")" });
      return;
    }

    const result = await storeGroundMedia({
      db: prisma,
      groundSourceId: groundSourceId || null,
      groupJid: groupJid || null,
      file: {
        originalname: file.originalname,
        buffer: file.buffer,
        mimetype: file.mimetype,
      },
      storeObject: uploadBufferToS3,
    });

    if (!result.ok) {
      // The log line is part of the contract: unconsented upload attempts
      // must be visible, not silently dropped (same as /api/ground/ingest).
      console.warn(
        `[ground-media] consent gate rejected upload (${groundSourceId || groupJid}):`,
        result.reason,
      );
      res.status(403).json({
        error: "Consent gate: media storage is not permitted for this source",
        reason: result.reason,
      });
      return;
    }

    res.json({ key: result.key, groundSourceId: result.groundSourceId });
  } catch (err) {
    console.error("[ground-media] Failed:", err);
    res.status(500).json({ error: "Media upload failed" });
  }
});

export { router as groundMediaRouter };
