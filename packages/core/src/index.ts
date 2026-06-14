export {
  getToken,
  getTokenSilent,
  getTokenForScope,
  loginAutomated,
  loadSecrets,
  forceReauth,
} from "./auth.js";

export {
  noteRequestOutcome,
  createReauthTracker,
  type ReauthTracker,
  type ReauthTrackerOptions,
} from "./auth-recovery.js";

export { getOrCreateAgent } from "./agent.js";

export {
  copilotChat,
  decodeJwt,
  getToneForModel,
  getAvailableModels,
  type CopilotStream,
} from "./copilot.js";

export {
  CopilotSession,
  type CopilotSessionOptions,
} from "./session.js";

export {
  ModelSession,
  type ModelSessionOptions,
} from "./model.js";

export {
  formatMessages,
  formatToolDefinitions,
  formatToolChoiceInstruction,
  getMessageContent,
  parseToolCalls,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  isProseDocument,
  type Message,
  type ToolDef,
  type ToolFunction,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
} from "./tools.js";

export { createLogger, trunc, LOG_PATH } from "./log.js";
