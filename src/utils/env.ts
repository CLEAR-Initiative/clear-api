import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),

  // Frontend URL (for verification links)
  FRONTEND_URL: z.string().default("http://localhost:3000"),

  // Email provider: "smtp" | "postmark"
  EMAIL_PROVIDER: z.string().default("smtp"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("noreply@clear-platform.org"),
  POSTMARK_SERVER_TOKEN: z.string().optional(),
  POSTMARK_SENDER_EMAIL: z.string().optional(),

  // Celery broker (Redis) — for sending tasks to clear-pipeline workers
  CELERY_BROKER_URL: z.string().default("redis://localhost:6379/0"),

  // S3 (for manual signal media uploads)
  S3_BUCKET: z.string().default("clear-media"),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().optional(), // For S3-compatible services (MinIO, R2, etc.)

  // Global admin seed (env overrides seed defaults)
  ADMIN_EMAIL: z.string().email().default("admin@clear.dev"),
  ADMIN_PASSWORD: z.string().min(8).default("password123"),
});

const parsed = envSchema.parse(process.env);

export const env = {
  ...parsed,
  CORS_ORIGINS: parsed.CORS_ORIGINS.split(",").map((s) => s.trim()),
};
