import type { IResolvers } from "@graphql-tools/utils";
import { scalarResolvers } from "./scalars.resolver.js";
import { authResolvers } from "./auth.resolver.js";
import { userResolvers } from "./user.resolver.js";
import { alertResolvers } from "./alert.resolver.js";
import { signalResolvers } from "./signal.resolver.js";
import { eventResolvers } from "./event.resolver.js";
import { dataSourceResolvers } from "./dataSource.resolver.js";
import { locationResolvers } from "./location.resolver.js";
import { notificationResolvers } from "./notification.resolver.js";
import { featureFlagResolvers } from "./featureFlag.resolver.js";
import { apiKeyResolvers } from "./apiKey.resolver.js";
import { disasterTypeResolvers } from "./disasterType.resolver.js";
import { organisationResolvers } from "./organisation.resolver.js";
import { teamResolvers } from "./team.resolver.js";
import { feedbackResolvers } from "./feedback.resolver.js";
import { invitationResolvers } from "./invitation.resolver.js";
import { subscriptionResolvers } from "./subscription.resolver.js";

export const resolvers: IResolvers[] = [
  scalarResolvers,
  authResolvers,
  userResolvers,
  alertResolvers,
  signalResolvers,
  eventResolvers,
  dataSourceResolvers,
  locationResolvers,
  notificationResolvers,
  featureFlagResolvers,
  apiKeyResolvers,
  disasterTypeResolvers,
  organisationResolvers,
  teamResolvers,
  feedbackResolvers,
  invitationResolvers,
  subscriptionResolvers,
];
