import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import express from "express";
import http from "node:http";
import cors from "cors";
import { typeDefs } from "./schema/index.js";
import { resolvers } from "./resolvers/index.js";
import { createContext, type Context } from "./context.js";
import { prisma } from "./lib/prisma.js";
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

app.use(
  "/graphql",
  cors<cors.CorsRequest>({ origin: env.CORS_ORIGIN }),
  express.json(),
  expressMiddleware(server, {
    context: createContext,
  }),
);

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

httpServer.listen(env.PORT, () => {
  console.log(`Server ready at http://localhost:${env.PORT}/graphql`);
});

const shutdown = async () => {
  await server.stop();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
