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
});

const parsed = envSchema.parse(process.env);

export const env = {
  ...parsed,
  CORS_ORIGINS: parsed.CORS_ORIGINS.split(",").map((s) => s.trim()),
};
