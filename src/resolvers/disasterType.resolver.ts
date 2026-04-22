import type { Context } from "../context.js";

interface DisasterRow {
  id: string;
  disasterType: string;
  disasterClass: string;
  glideNumber: string;
  level1: string;
  level2: string;
  idType: string;
}

export const disasterTypeResolvers = {
  Query: {
    disasterTypes: (_parent: unknown, _args: unknown, { prisma }: Context) => {
      return prisma.disasterTypes.findMany();
    },
    disasterType: (_parent: unknown, args: { id: string }, { prisma }: Context) => {
      return prisma.disasterTypes.findUnique({ where: { id: args.id } });
    },

    /**
     * Grouped disaster types for hierarchical UI.
     * Groups: level1 → level2 → [level3 rows]
     */
    disasterTypeHierarchy: async (_parent: unknown, _args: unknown, { prisma }: Context) => {
      const rows = (await prisma.disasterTypes.findMany({
        orderBy: [{ level1: "asc" }, { level2: "asc" }, { disasterType: "asc" }],
      })) as DisasterRow[];

      const level1Map = new Map<string, Map<string, DisasterRow[]>>();
      for (const row of rows) {
        // Fall back to legacy disasterClass if level1 is not yet populated
        const l1 = row.level1 || row.disasterClass || "other";
        const l2 = row.level2 || row.disasterType || "other";

        let l1Group = level1Map.get(l1);
        if (!l1Group) {
          l1Group = new Map();
          level1Map.set(l1, l1Group);
        }
        const l2List = l1Group.get(l2) ?? [];
        l2List.push(row);
        l1Group.set(l2, l2List);
      }

      return [...level1Map.entries()].map(([name, l1Group]) => ({
        name,
        groups: [...l1Group.entries()].map(([l2Name, subTypes]) => ({
          name: l2Name,
          codes: [...new Set(subTypes.map((r) => r.glideNumber))],
          subTypes,
        })),
      }));
    },
  },
};
