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

  // SMS provider: "twilio" | "46elks"
  SMS_PROVIDER: z.string().default("twilio"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  ELKS46_API_USERNAME: z.string().optional(),
  ELKS46_API_PASSWORD: z.string().optional(),
  ELKS46_FROM: z.string().optional(),

  // Celery broker (Redis) — for sending tasks to clear-pipeline workers
  CELERY_BROKER_URL: z.string().default("redis://localhost:6379/0"),

  // S3 (for manual signal media uploads)
  S3_BUCKET: z.string().default("clear-media"),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),

  // Global admin seed (env overrides seed defaults)
  ADMIN_EMAIL: z.string().email().default("admin@clear.dev"),
  ADMIN_PASSWORD: z.string().min(8).default("password123"),

  // ─── Exponential CRM integration ─────────────────────────────────────
  // Used to push new signups into the prospects collection and to move
  // approved users into the approved collection. All optional in dev so
  // the absence of these vars degrades cleanly (the CRM calls become
  // best-effort no-ops with a log line, not a startup failure).
  EXPONENTIAL_API_URL: z.string().url().optional(),
  /** Long-lived JWT bearer token issued by Exponential. Used as
   *  `Authorization: Bearer <token>` on every Exponential request.
   *  Resolves to a user; that user must be a member of the workspace
   *  and have edit rights on the prospects + approved collections. */
  EXPONENTIAL_JWT: z.string().optional(),
  EXPONENTIAL_WORKSPACE_ID: z.string().optional(),
  /** Collection id holding contacts that signed up but haven't been
   *  approved yet. Members are added here from the Better Auth signup
   *  hook. */
  EXPONENTIAL_PROSPECTS_COLLECTION_ID: z.string().optional(),
  /** Collection id holding admin-approved contacts. The approval action
   *  removes the contact from prospects and adds it here. */
  EXPONENTIAL_APPROVED_COLLECTION_ID: z.string().optional(),

  // ─── Dagster (knowledge-base manual ingest trigger) ──────────────
  // Used by `uploadKnowledgebaseDocument` to hand off freshly uploaded
  // PDFs to the `process_manual_document_job` in dagster-quickstart.
  // All optional in dev: when unset, the mutation still uploads to S3
  // but returns a UNKNOWN-status job (i.e. no run is launched) — useful
  // when Dagster is offline and you just want to stage a PDF.
  /** Base URL of the Dagster webserver, e.g. http://localhost:3000. */
  DAGSTER_URL: z.string().url().optional(),
  /** Location name Dagster's UI shows for the dagster-quickstart code
   *  location. Typically `dagster_quickstart` (module name) or
   *  `dagster-quickstart` (project slug). Run
   *  `curl <dagster_url>/graphql -d '{"query":"{ repositoryLocations{ id name } }"}'`
   *  to check. */
  DAGSTER_REPOSITORY_LOCATION_NAME: z.string().default("clear-context-pipeline"),
  /** Repository name inside that location. Dagster auto-names it
   *  `__repository__` when the module uses `@definitions`. */
  DAGSTER_REPOSITORY_NAME: z.string().default("__repository__"),

  // ─── Webhook receiver (GlitchTip → clear-api) ────────────────────
  /** Shared secret required as `?token=` query param on
   *  POST /webhooks/glitchtip. Rotates via redeploy — set it in the
   *  environment env, and re-configure each GlitchTip project's Alert
   *  Rule webhook URL to include the new token. Empty value disables
   *  the endpoint (returns 503) — used in tests + local dev when the
   *  admin hasn't provisioned a token yet. Keep this ≥ 32 hex chars
   *  when set (`openssl rand -hex 32`). */
  GLITCHTIP_WEBHOOK_TOKEN: z.string().default(""),
});

const parsed = envSchema.parse(process.env);

export const env = {
  ...parsed,
  CORS_ORIGINS: parsed.CORS_ORIGINS.split(",").map((s) => s.trim()),
};
