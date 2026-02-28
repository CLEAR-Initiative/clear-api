import type { ApolloServerPlugin } from "@apollo/server";
import type { Context } from "../context.js";

export const loggingPlugin: ApolloServerPlugin<Context> = {
  async requestDidStart() {
    return {
      async didEncounterErrors({ errors }) {
        for (const error of errors) {
          console.error("GraphQL Error:", error.message);
        }
      },
    };
  },
};
