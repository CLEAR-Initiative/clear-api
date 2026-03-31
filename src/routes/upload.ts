/**
 * REST endpoint for uploading signal media files to S3.
 *
 * POST /api/upload
 *   - Accepts multipart/form-data with one or more files under the "files" field
 *   - Requires authentication (session cookie)
 *   - Returns { urls: string[] }
 */

import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../utils/env.js";
import { auth } from "../lib/auth.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});

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

router.post("/", upload.array("files", 10), async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers as Record<string, string> });
    if (!session?.user) {
      res.status(401).json({ error: "Unauthorized" });
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
      const ext = file.originalname.includes(".") ? file.originalname.split(".").pop() : "";
      const key = `signals/${randomUUID()}${ext ? `.${ext}` : ""}`;

      await s3.send(new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }));

      keys.push(key);
    }

    // Return S3 keys (not URLs) — presigned URLs are generated at read time
    res.json({ keys });
  } catch (err) {
    console.error("[upload] Failed:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

export { router as uploadRouter };
