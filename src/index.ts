import "dotenv/config";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import express from "express";
import http from "node:http";
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
import graphqlUploadExpress from "graphql-upload/graphqlUploadExpress.mjs";
import { uploadRouter } from "./routes/upload.js";

const app = express();
const httpServer = http.createServer(app);

const server = new ApolloServer<Context>({
  typeDefs,
  resolvers,
  plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
  introspection: env.NODE_ENV !== "production",
  csrfPrevention: false,
});

await server.start();

// CORS — global, with credentials for cookie-based sessions
app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));

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

// Health check
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// GraphQL (with multipart upload support)
app.use(
  "/graphql",
  graphqlUploadExpress({ maxFileSize: 20_000_000, maxFiles: 10 }),
  express.json(),
  expressMiddleware(server, {
    context: createContext,
  }),
);

httpServer.listen(env.PORT, () => {
  console.log(`Server ready at http://localhost:${env.PORT}/graphql`);
  console.log(`Auth API at http://localhost:${env.PORT}/api/auth`);
});

const shutdown = async () => {
  await server.stop();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
