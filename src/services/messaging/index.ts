export type {
  EmailProvider,
  SMSProvider,
  SendEmailOptions,
  SendSMSOptions,
} from "./types.js";

export { getEmailProvider, getSMSProvider, resetProviders } from "./registry.js";

export * as templates from "./templates.js";
