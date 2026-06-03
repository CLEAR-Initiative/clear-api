/**
 * REST endpoint for uploading files to S3.
 *
 * POST /api/upload  (multipart/form-data, files under the "files" field)
 *
 * Two authenticated callers, distinguished by auth method:
 *   - **Session** (UI user): signal media — stored under `signals/{uuid}.{ext}`
 *     (unchanged legacy behaviour; pre-uploaded keys feed createManualSignal).
 *   - **API key** (`Bearer sk_live_…`, role admin/pipeline): the CLEAR pipeline
 *     archiving **source PDFs** — stored under `sources/{sha256}.pdf`, keyed by
 *     content hash so identical re-uploads are idempotent (one S3 object).
 *
 * Unauthenticated callers get 401; an authenticated-but-wrong-role API key
 * (e.g. viewer) gets 403. Returns { keys: string[] }.
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { randomUUID, createHash } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../utils/env.js";
import { resolveRequestAuth } from "../utils/request-auth.js";

const router = Router();

// 50 MB — humanitarian source PDFs occasionally exceed the old 20 MB cap.
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const UPLOAD_ROLES = new Set(["admin", "pipeline"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 10 },
});

/** Content-hash archive key for a source PDF. Deterministic in the bytes, so
 * re-uploading identical content overwrites the same key (one S3 object). */
export function sourceKeyForBytes(buffer: Buffer): string {
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return `sources/${sha256}.pdf`;
}

/** Legacy random key for session-uploaded signal media. */
export function legacyMediaKey(originalname: string): string {
  const ext = originalname.includes(".") ? originalname.split(".").pop() : "";
  return `signals/${randomUUID()}${ext ? `.${ext}` : ""}`;
}

let _s3: S3Client | null = null;
function getS3(): S3Client {
  if (_s3) return _s3;
  _s3 = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } }
      : {}),
  });
  return _s3;
}

/** multer middleware wrapper that turns size-limit errors into a clean 413. */
function uploadArray(req: Request, res: Response, next: NextFunction): void {
  upload.array("files", 10)(req, res, (err: unknown) => {
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

router.post("/", uploadArray, async (req, res) => {
  try {
    const { user, authMethod } = await resolveRequestAuth(req.headers);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // The source-PDF archive path is restricted to the pipeline/admin key.
    const isApiKey = authMethod === "api-key";
    if (isApiKey && !UPLOAD_ROLES.has(user.role ?? "")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ error: "No files uploaded" });
      return;
    }

    const s3 = getS3();
    const keys: string[] = [];

    for (const file of files) {
      const key = isApiKey
        ? sourceKeyForBytes(file.buffer)
        : legacyMediaKey(file.originalname);

      await s3.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
      );

      keys.push(key);
    }

    // Return S3 keys (not URLs) — presigned URLs are generated at read time.
    res.json({ keys });
  } catch (err) {
    console.error("[upload] Failed:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

export { router as uploadRouter };
