import { queryTypeDef } from "./typeDefs/query.js";
import { mutationTypeDef } from "./typeDefs/mutation.js";
import { exampleTypeDef } from "./typeDefs/types/example.js";

export const typeDefs = [queryTypeDef, mutationTypeDef, exampleTypeDef];
