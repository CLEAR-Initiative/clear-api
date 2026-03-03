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

const app = express();
const httpServer = http.createServer(app);

const server = new ApolloServer<Context>({
  typeDefs,
  resolvers,
  plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
  introspection: env.NODE_ENV !== "production",
});

await server.start();

// CORS — scoped to non-auth routes (Better Auth handles its own CORS via trustedOrigins)
const corsMiddleware = cors({ origin: env.CORS_ORIGINS, credentials: true });

// Better Auth handler — MUST be before express.json()
app.all("/api/auth/*splat", toNodeHandler(auth));

// Health check
app.get("/health", corsMiddleware, (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// GraphQL — express.json() scoped to this route only
app.use(
  "/graphql",
  corsMiddleware,
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
