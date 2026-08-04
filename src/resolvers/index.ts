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
import { devUserResolvers } from "./devUser.resolver.js";
import { publicEventResolvers } from "./publicEvent.resolver.js";
import { disasterTypeResolvers } from "./disasterType.resolver.js";
import { organisationResolvers } from "./organisation.resolver.js";
import { teamResolvers } from "./team.resolver.js";
import { feedbackResolvers } from "./feedback.resolver.js";
import { invitationResolvers } from "./invitation.resolver.js";
import { subscriptionResolvers } from "./subscription.resolver.js";
import { crisisResolvers } from "./crisis.resolver.js";
import { locationMetadataResolvers } from "./locationMetadata.resolver.js";
import { nominatimCacheResolvers } from "./nominatimCache.resolver.js";
import { paginationResolvers } from "./pagination.resolver.js";
import { activityLogResolvers } from "./activityLog.resolver.js";
import { pipelineCountryResolvers } from "./pipelineCountry.resolver.js";
import { translationResolvers } from "./translation.resolver.js";
import { knowledgebaseResolvers } from "./knowledgebase.resolver.js";
import { gazetteerResolvers } from "./gazetteer.resolver.js";
import { datapointResolvers } from "./datapoint.resolver.js";
import { situationAnalysisResolvers } from "./situationAnalysis.resolver.js";
import { webhookResolvers } from "./webhook.resolver.js";
import { groundResolvers } from "./ground.resolver.js";

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
  devUserResolvers,
  publicEventResolvers,
  disasterTypeResolvers,
  organisationResolvers,
  teamResolvers,
  feedbackResolvers,
  invitationResolvers,
  subscriptionResolvers,
  crisisResolvers,
  locationMetadataResolvers,
  nominatimCacheResolvers,
  paginationResolvers,
  activityLogResolvers,
  pipelineCountryResolvers,
  translationResolvers,
  knowledgebaseResolvers,
  gazetteerResolvers,
  datapointResolvers,
  situationAnalysisResolvers,
  webhookResolvers,
  groundResolvers,
];
