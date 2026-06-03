import { scalarTypeDef } from "./typeDefs/scalars.js";
import { queryTypeDef } from "./typeDefs/query.js";
import { mutationTypeDef } from "./typeDefs/mutation.js";
import { userTypeDef } from "./typeDefs/types/user.js";
import { alertTypeDef } from "./typeDefs/types/alert.js";
import { detectionTypeDef } from "./typeDefs/types/detection.js";
import { signalTypeDef } from "./typeDefs/types/signal.js";
import { eventTypeDef } from "./typeDefs/types/event.js";
import { dataSourceTypeDef } from "./typeDefs/types/dataSource.js";
import { locationTypeDef } from "./typeDefs/types/location.js";
import { notificationTypeDef } from "./typeDefs/types/notification.js";
import { featureFlagTypeDef } from "./typeDefs/types/featureFlag.js";
import { apiKeyTypeDef } from "./typeDefs/types/apiKey.js";
import { feedbackTypeDef } from "./typeDefs/types/feedback.js";
import { disasterTypeTypeDef } from "./typeDefs/types/disasterType.js";
import { organisationTypeDef } from "./typeDefs/types/organisation.js";
import { teamTypeDef } from "./typeDefs/types/team.js";
import { invitationTypeDef } from "./typeDefs/types/invitation.js";
import { crisisTypeDef } from "./typeDefs/types/crisis.js";
import { locationMetadataTypeDef } from "./typeDefs/types/locationMetadata.js";
import { nominatimCacheTypeDef } from "./typeDefs/types/nominatimCache.js";
import { paginationTypeDef } from "./typeDefs/types/pagination.js";
import { pipelineCountryTypeDef } from "./typeDefs/types/pipelineCountry.js";

export const typeDefs = [
  scalarTypeDef,
  queryTypeDef,
  mutationTypeDef,
  userTypeDef,
  alertTypeDef,
  detectionTypeDef,
  signalTypeDef,
  eventTypeDef,
  dataSourceTypeDef,
  locationTypeDef,
  notificationTypeDef,
  featureFlagTypeDef,
  apiKeyTypeDef,
  feedbackTypeDef,
  disasterTypeTypeDef,
  organisationTypeDef,
  teamTypeDef,
  invitationTypeDef,
  crisisTypeDef,
  locationMetadataTypeDef,
  nominatimCacheTypeDef,
  paginationTypeDef,
  pipelineCountryTypeDef,
];
