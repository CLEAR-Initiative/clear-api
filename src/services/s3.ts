/**
 * S3 service for signal media files.
 *
 * Stores S3 keys (not URLs) in the database.
 * Generates presigned GET URLs at runtime when serving media.
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { env } from "../utils/env.js";

const PRESIGNED_URL_EXPIRY = 3600; // 1 hour

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;

  _client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });

  return _client;
}

/**
 * Upload a file stream to S3. Returns the S3 key (NOT a URL).
 */
export async function uploadFileToS3(
  stream: NodeJS.ReadableStream,
  filename: string,
  mimetype: string,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  const buffer = Buffer.concat(chunks);

  const ext = filename.includes(".") ? filename.split(".").pop() : "";
  const key = `signals/${randomUUID()}${ext ? `.${ext}` : ""}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    }),
  );

  return key;
}

/**
 * Generate a presigned GET URL for an S3 key.
 * URLs expire after 1 hour.
 */
export async function getPresignedUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
  });
  return getSignedUrl(getClient(), command, { expiresIn: PRESIGNED_URL_EXPIRY });
}

/**
 * Generate presigned GET URLs for multiple S3 keys.
 */
export async function getPresignedUrls(keys: string[]): Promise<string[]> {
  return Promise.all(keys.map(getPresignedUrl));
}
