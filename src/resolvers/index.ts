import { scalarResolvers } from "./scalars.resolver.js";
import { userResolvers } from "./user.resolver.js";
import { alertResolvers } from "./alert.resolver.js";
import { detectionResolvers } from "./detection.resolver.js";
import { dataSourceResolvers } from "./dataSource.resolver.js";
import { locationResolvers } from "./location.resolver.js";
import { featureFlagResolvers } from "./featureFlag.resolver.js";

export const resolvers = [
  scalarResolvers,
  userResolvers,
  alertResolvers,
  detectionResolvers,
  dataSourceResolvers,
  locationResolvers,
  featureFlagResolvers,
];
