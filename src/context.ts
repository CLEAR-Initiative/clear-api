import type { ExpressContextFunctionArgument } from "@as-integrations/express5";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Context {
  // Add auth tokens, data sources, etc.
}

export async function createContext(
  _args: ExpressContextFunctionArgument,
): Promise<Context> {
  return {};
}
