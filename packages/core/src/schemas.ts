import { z } from "zod/v4";

// --- SignalR Protocol Schemas ---

export const SignalRHandshakeResponse = z.object({
  error: z.string().optional(),
});

export const SignalRBase = z.object({
  type: z.number(),
});

// --- M365 Copilot Response Schemas ---

export const ThrottlingInfo = z.object({
  maxNumUserMessagesInConversation: z.number(),
  numUserMessagesInConversation: z.number(),
  numLongDocSummaryUserMessagesInConversation: z.number(),
});

export const BotMessage = z.object({
  text: z.string(),
  author: z.literal("bot"),
  responseIdentifier: z.string().optional(),
  createdAt: z.string().optional(),
  timestamp: z.string().optional(),
  messageId: z.string().optional(),
  requestId: z.string().optional(),
  offense: z.string().optional(),
  messageType: z.string().optional(),
  adaptiveCards: z.array(z.any()).optional(),
  sourceAttributions: z.array(z.any()).optional(),
  contentOrigin: z.string().optional(),
  suggestedResponses: z
    .array(
      z.object({
        text: z.string(),
        commandText: z.string().optional(),
        author: z.string().optional(),
      }),
    )
    .optional(),
});

export const CursorInfo = z.object({
  j: z.string(),
  p: z.number(),
});

// Update frame with delta text (streaming mode)
export const DeltaUpdate = z.object({
  writeAtCursor: z.string(),
  sourceAttributions: z.array(z.any()).optional(),
  streamingMode: z.literal("Delta").optional(),
  nonce: z.string().optional(),
});

// Update frame with full/initial message
export const MessageUpdate = z.object({
  messages: z.array(BotMessage.partial().extend({ author: z.string() })),
  nonce: z.string().optional(),
  cursor: CursorInfo.optional(),
  streamingMode: z.string().optional(),
  requestId: z.string().optional(),
});

// Update frame with throttling info
export const ThrottlingUpdate = z.object({
  nonce: z.string().optional(),
  requestId: z.string().optional(),
  throttling: ThrottlingInfo,
});

// SignalR type 1 "update" target
export const UpdateFrame = z.object({
  type: z.literal(1),
  target: z.literal("update"),
  arguments: z.array(
    z.union([DeltaUpdate, MessageUpdate, ThrottlingUpdate, z.record(z.any())]),
  ),
});

// SignalR type 2 - stream item (completion with conversation state)
export const StreamItemFrame = z.object({
  type: z.literal(2),
  invocationId: z.string(),
  item: z.any(),
});

// SignalR type 3 - completion
export const CompletionFrame = z.object({
  type: z.literal(3),
  invocationId: z.string(),
  error: z.string().optional(),
  result: z.any().optional(),
});

// SignalR type 6 - ping
export const PingFrame = z.object({
  type: z.literal(6),
});

// SignalR type 7 - close
export const CloseFrame = z.object({
  type: z.literal(7),
  error: z.string().optional(),
});

// Union of all server frames
export const ServerFrame = z.union([
  UpdateFrame,
  StreamItemFrame,
  CompletionFrame,
  PingFrame,
  CloseFrame,
]);

// --- OpenAI Request Schemas ---

export const ToolCallFunction = z.object({
  name: z.string(),
  arguments: z.string(),
});

export const ToolCall = z.object({
  id: z.string(),
  type: z.literal("function").default("function"),
  function: ToolCallFunction,
});

export const ToolDefinition = z.object({
  type: z.literal("function").default("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.any().optional(),
  }),
});

export const ChatMessage = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([
    z.string(),
    z.array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
      }),
    ),
  ]).nullable().optional(),
  tool_calls: z.array(ToolCall).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

export const ChatCompletionRequest = z.object({
  model: z.string().optional().default("m365-copilot"),
  messages: z.array(ChatMessage).min(1),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  tools: z.array(ToolDefinition).optional(),
  tool_choice: z.union([
    z.enum(["auto", "none", "required"]),
    z.object({
      type: z.literal("function"),
      function: z.object({ name: z.string() }),
    }),
  ]).optional(),
});

// --- JWT Claims ---

export const JwtClaims = z.object({
  aud: z.string(),
  iss: z.string(),
  oid: z.string(),
  tid: z.string(),
  exp: z.number(),
  name: z.string().optional(),
  upn: z.string().optional(),
});
