import "dotenv/config";
// Sentry must be imported BEFORE anything that may throw — its init runs as a
// side effect of module load, attaching the global error handler. If imported
// later, errors raised during earlier imports go uncaught.
import { sentryApolloPlugin } from "./utils/sentry.js";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import express from "express";
import http from "node:http";
import { join } from "node:path";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { typeDefs } from "./schema/index.js";
import { resolvers } from "./resolvers/index.js";
import { createContext, type Context } from "./context.js";
import { prisma } from "./lib/prisma.js";
import { auth } from "./lib/auth.js";
import { env } from "./utils/env.js";
import { portalRouter } from "./portal/index.js";
import { homeRouter } from "./home/index.js";
import { createDocsRouter } from "./docs/index.js";
import { cssRouter } from "./ui/css-routes.js";
import graphqlUploadExpress from "graphql-upload/graphqlUploadExpress.mjs";
import { uploadRouter } from "./routes/upload.js";
import { groundUploadRouter } from "./routes/ground-upload.js";
import { groundIngestRouter } from "./routes/ground-ingest.js";
import { groundMediaRouter } from "./routes/ground-media.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { logieRouter } from "./routes/logie.js";
import { startWebhookRetryWorker } from "./services/webhook/worker.js";

const app = express();
const httpServer = http.createServer(app);

const server = new ApolloServer<Context>({
  typeDefs,
  resolvers,
  plugins: [ApolloServerPluginDrainHttpServer({ httpServer }), sentryApolloPlugin],
  introspection: env.NODE_ENV !== "production",
  csrfPrevention: false,
});

await server.start();

// CORS — global, with credentials for cookie-based sessions
app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));

// Static assets (favicon, icons), served from <cwd>/public. cwd is the repo
// root in dev and /app in the production image (WORKDIR /app) — the Dockerfile
// copies public/ there so this resolves in both environments.
// Static assets (favicon, icons), served from <cwd>/public. cwd is the repo
// root in dev and /app in the production image (WORKDIR /app) — the Dockerfile
// copies public/ there so this resolves in both environments.
// Shared portal chrome CSS is a TS-generated stylesheet (not a file in
// public/) so tokens stay the source of truth and the browser can cache
// it across /portal, /docs, and /portal/admin.
app.use(express.static(join(process.cwd(), "public"), { maxAge: "1d" }));
app.use("/css", cssRouter);

// Better Auth handler — MUST be before express.json()
app.all("/api/auth/*splat", toNodeHandler(auth));

// Developer portal
app.use("/portal", portalRouter);

// Auto-generated docs (pre-built HTML)
app.use("/docs", createDocsRouter());

// Public home page
app.use("/", homeRouter);

// Media upload (multipart/form-data → S3)
app.use("/api/upload", uploadRouter);

// WhatsApp chat-export ingest into the ground staging tier
// (multipart/form-data; admin/analyst only)
app.use("/api/ground/upload", groundUploadRouter);

// Live gateway ingest into the ground staging tier (JSON; machine auth,
// consent-gated per group JID — see routes/ground-ingest.ts)
app.use("/api/ground/ingest", groundIngestRouter);

// Live gateway media byte upload into the ground staging tier
// (multipart/form-data; machine auth, consent-gated — see
// routes/ground-media.ts)
app.use("/api/ground/media", groundMediaRouter);

// External webhook receiver (GlitchTip → clear-api). Scoped
// express.json() because the global GraphQL mount does its own — we
// want a small body limit here (webhooks are tiny) and to avoid
// coupling to the global handler.
app.use(
  "/webhooks",
  express.json({ limit: "1mb" }),
  webhooksRouter,
);

// LogIE Blockages serve (map-ready slim GeoJSON from persisted metadata).
// Read-only GET; auth is enforced inside the route (session or API key).
app.use("/api/logie", logieRouter);

// Health check
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// GraphQL (with multipart upload support)
app.use(
  "/graphql",
  graphqlUploadExpress({ maxFileSize: 20_000_000, maxFiles: 10 }),
  express.json({ limit: "50mb" }),
  expressMiddleware(server, {
    context: createContext,
  }),
);

httpServer.listen(env.PORT, () => {
  console.log(`Server ready at http://localhost:${env.PORT}/graphql`);
  console.log(`Auth API at http://localhost:${env.PORT}/api/auth`);
  // Start the webhook retry poller — checks `webhook_deliveries` for
  // due retries every 15s. Safe to start unconditionally; if there are
  // no rows, the tick is essentially free.
  startWebhookRetryWorker(prisma);
});

const shutdown = async () => {
  await server.stop();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
