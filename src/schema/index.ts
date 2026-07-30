import { scalarTypeDef } from "./typeDefs/scalars.js";
import { queryTypeDef } from "./typeDefs/query.js";
import { mutationTypeDef } from "./typeDefs/mutation.js";
import { userTypeDef } from "./typeDefs/types/user.js";
import { alertTypeDef } from "./typeDefs/types/alert.js";
import { detectionTypeDef } from "./typeDefs/types/detection.js";
import { signalTypeDef } from "./typeDefs/types/signal.js";
import { signalLocationChallengeTypeDef } from "./typeDefs/types/signalLocationChallenge.js";
import { eventTypeDef } from "./typeDefs/types/event.js";
import { dataSourceTypeDef } from "./typeDefs/types/dataSource.js";
import { locationTypeDef } from "./typeDefs/types/location.js";
import { notificationTypeDef } from "./typeDefs/types/notification.js";
import { featureFlagTypeDef } from "./typeDefs/types/featureFlag.js";
import { apiKeyTypeDef } from "./typeDefs/types/apiKey.js";
import { devUserTypeDef } from "./typeDefs/types/devUser.js";
import { publicEventTypeDef } from "./typeDefs/types/publicEvent.js";
import { feedbackTypeDef } from "./typeDefs/types/feedback.js";
import { disasterTypeTypeDef } from "./typeDefs/types/disasterType.js";
import { organisationTypeDef } from "./typeDefs/types/organisation.js";
import { teamTypeDef } from "./typeDefs/types/team.js";
import { invitationTypeDef } from "./typeDefs/types/invitation.js";
import { crisisTypeDef } from "./typeDefs/types/crisis.js";
import { locationMetadataTypeDef } from "./typeDefs/types/locationMetadata.js";
import { nominatimCacheTypeDef } from "./typeDefs/types/nominatimCache.js";
import { paginationTypeDef } from "./typeDefs/types/pagination.js";
import { activityLogTypeDef } from "./typeDefs/types/activityLog.js";
import { pipelineCountryTypeDef } from "./typeDefs/types/pipelineCountry.js";
import { translationTypeDef } from "./typeDefs/types/translation.js";
import { knowledgebaseTypeDef } from "./typeDefs/types/knowledgebase.js";
import { gazetteerTypeDef } from "./typeDefs/types/gazetteer.js";
import { datapointTypeDef } from "./typeDefs/types/datapoint.js";
import { situationAnalysisTypeDef } from "./typeDefs/types/situationAnalysis.js";
import { webhookTypeDef } from "./typeDefs/types/webhook.js";

export const typeDefs = [
  scalarTypeDef,
  queryTypeDef,
  mutationTypeDef,
  userTypeDef,
  alertTypeDef,
  detectionTypeDef,
  signalTypeDef,
  signalLocationChallengeTypeDef,
  eventTypeDef,
  dataSourceTypeDef,
  locationTypeDef,
  notificationTypeDef,
  featureFlagTypeDef,
  apiKeyTypeDef,
  devUserTypeDef,
  publicEventTypeDef,
  feedbackTypeDef,
  disasterTypeTypeDef,
  organisationTypeDef,
  teamTypeDef,
  invitationTypeDef,
  crisisTypeDef,
  locationMetadataTypeDef,
  nominatimCacheTypeDef,
  paginationTypeDef,
  activityLogTypeDef,
  pipelineCountryTypeDef,
  translationTypeDef,
  knowledgebaseTypeDef,
  gazetteerTypeDef,
  datapointTypeDef,
  situationAnalysisTypeDef,
  webhookTypeDef,
];
