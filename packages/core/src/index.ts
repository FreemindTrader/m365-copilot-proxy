export {
  getToken,
  getTokenSilent,
  getTokenForScope,
  loginInteractive,
  loginAutomated,
  loadSecrets,
} from "./auth.js";

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
  type Message,
  type ToolDef,
  type ToolFunction,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
} from "./tools.js";

export { createLogger, LOG_PATH } from "./log.js";
