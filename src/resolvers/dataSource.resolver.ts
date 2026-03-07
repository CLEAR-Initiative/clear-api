import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";

interface CreateDataSourceInput {
  name: string;
  type: string;
  isActive?: boolean;
  baseUrl?: string;
  infoUrl?: string;
}

interface UpdateDataSourceInput {
  name?: string;
  type?: string;
  isActive?: boolean;
  baseUrl?: string;
  infoUrl?: string;
}

export const dataSourceResolvers = {
  Query: {
    dataSources: (_parent: unknown, _args: unknown, { prisma }: Context) => {
      return prisma.dataSource.findMany();
    },
    dataSource: (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      return prisma.dataSource.findUnique({ where: { id: args.id } });
    },
  },
  Mutation: {
    createDataSource: async (
      _parent: unknown,
      args: { input: CreateDataSourceInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { input } = args;

      return context.prisma.dataSource.create({
        data: {
          name: input.name,
          type: input.type,
          isActive: input.isActive ?? true,
          baseUrl: input.baseUrl,
          infoUrl: input.infoUrl,
        },
      });
    },

    updateDataSource: async (
      _parent: unknown,
      args: { id: string; input: UpdateDataSourceInput },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const { id, input } = args;

      const existing = await context.prisma.dataSource.findUnique({ where: { id } });
      if (!existing) {
        throw new GraphQLError("DataSource not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      return context.prisma.dataSource.update({
        where: { id },
        data: {
          name: input.name ?? undefined,
          type: input.type ?? undefined,
          isActive: input.isActive ?? undefined,
          baseUrl: input.baseUrl,
          infoUrl: input.infoUrl,
        },
      });
    },

    deleteDataSource: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);

      const existing = await context.prisma.dataSource.findUnique({
        where: { id: args.id },
      });
      if (!existing) {
        throw new GraphQLError("DataSource not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.dataSource.delete({ where: { id: args.id } });
      return true;
    },
  },
  DataSource: {
    detections: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.detection.findMany({ where: { sourceId: parent.id } });
    },
    alerts: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.alert.findMany({ where: { sourceId: parent.id } });
    },
  },
};
