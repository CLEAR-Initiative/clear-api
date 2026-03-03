import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
});

const parsed = envSchema.parse(process.env);

export const env = {
  ...parsed,
  CORS_ORIGINS: parsed.CORS_ORIGINS.split(",").map((s) => s.trim()),
};
