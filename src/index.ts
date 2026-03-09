import "dotenv/config";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import express from "express";
import http from "node:http";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { typeDefs } from "./schema/index.js";
import { resolvers } from "./resolvers/index.js";
import { createContext, type Context } from "./context.js";
import { prisma } from "./lib/prisma.js";
import { auth } from "./lib/auth.js";
import { env } from "./utils/env.js";
import { portalRouter } from "./portal/index.js";
import { homeRouter } from "./home/index.js";
import { createDocsRouter } from "./docs/index.js";

const app = express();
const httpServer = http.createServer(app);

const schema = makeExecutableSchema({ typeDefs, resolvers });

const server = new ApolloServer<Context>({
  schema,
  plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
  introspection: env.NODE_ENV !== "production",
});

await server.start();

// CORS — global, with credentials for cookie-based sessions
app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));

// Better Auth handler — MUST be before express.json()
app.all("/api/auth/*splat", toNodeHandler(auth));

// Developer portal
app.use("/portal", portalRouter);

// Auto-generated docs (introspects the running schema)
app.use("/docs", createDocsRouter(schema));

// Public home page
app.use("/", homeRouter);

// Health check
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// GraphQL — express.json() scoped to this route only
app.use(
  "/graphql",
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
