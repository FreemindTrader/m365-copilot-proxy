import { Hono } from "hono";
import { cors } from "hono/cors";
import { type ModelSessionOptions, getAvailableModels } from "@opencode-m365/core";
import { ChatCompletionRequest } from "./schemas.js";
import { SessionPool, handleChatCompletion } from "./handler.js";

export { SessionPool } from "./handler.js";
export { ChatCompletionRequest, ChatMessage, ToolCall, ToolDefinition } from "./schemas.js";

// Re-export tool utilities from core
export {
  formatMessages,
  formatToolDefinitions,
  parseToolCalls,
  getMessageContent,
  type Message,
  type ToolDef,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
} from "@opencode-m365/core";

/**
 * Create a Hono app that serves an OpenAI-compatible API
 * backed by M365 Copilot. Each distinct conversation automatically
 * gets its own M365 session via the SessionPool.
 */
export function createApp(sessionOptions: ModelSessionOptions = {}): Hono {
  const pool = new SessionPool(sessionOptions);
  const app = new Hono();

  app.use("*", cors());

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/v1/models", (c) => {
    const created = Math.floor(Date.now() / 1000);
    return c.json({
      object: "list",
      data: getAvailableModels().map((id) => ({
        id,
        object: "model",
        created,
        owned_by: "microsoft",
      })),
    });
  });

  app.post("/v1/chat/completions", async (c) => {
    let body: ReturnType<typeof ChatCompletionRequest.parse>;
    try {
      body = ChatCompletionRequest.parse(await c.req.json());
    } catch (err: any) {
      return c.json(
        { error: { message: err.message, type: "invalid_request_error" } },
        400,
      );
    }

    return handleChatCompletion(body, pool);
  });

  return app;
}
