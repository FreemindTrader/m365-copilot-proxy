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
  ChatCompletionRequest,
  ChatMessage,
  JwtClaims,
  ToolCall,
  ToolDefinition,
} from "./schemas.js";

export {
  formatMessages,
  formatToolDefinitions,
  formatToolChoiceInstruction,
  getMessageContent,
  parseToolCalls,
  TOOL_CALL_FENCE,
  TOOL_CALL_FENCE_CLOSE,
  type ParsedMessage,
  type ToolDef,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
  type FormatOptions,
} from "./tools.js";

export {
  createProxyServer,
  type ProxyOptions,
  type ProxyServer,
} from "./proxy.js";

export {
  handleChatCompletion,
  HandlerContext,
  createHandlerContext,
  type HandlerOptions,
} from "./handler.js";

export {
  CopilotSession,
  type CopilotSessionOptions,
} from "./session.js";

export { createLogger, LOG_PATH } from "./log.js";
