import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  ChatCompletionRequest,
  copilotChat,
  getAvailableModels,
  getToken,
} from "@opencode-m365/core";

const PORT = parseInt(process.argv[2] || "4141", 10);

// --- Helpers ---

function formatMessages(messages: Array<{ role: string; content: string | any[] }>): string {
  if (messages.length === 1 && messages[0].role === "user") {
    const c = messages[0].content;
    return typeof c === "string" ? c : c.map((p: any) => p.text || "").join("");
  }
  return messages
    .map((m) => {
      const content =
        typeof m.content === "string"
          ? m.content
          : m.content.map((p: any) => p.text || "").join("");
      return `[${m.role}]\n${content}`;
    })
    .join("\n\n");
}

function extractTokenFromHeader(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (auth) return auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  return null;
}

async function resolveToken(req: IncomingMessage): Promise<string> {
  const headerToken = extractTokenFromHeader(req);
  if (headerToken) return headerToken;
  return getToken();
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

// --- Handlers ---

function handleModels(_req: IncomingMessage, res: ServerResponse) {
  const created = Math.floor(Date.now() / 1000);
  jsonResponse(res, 200, {
    object: "list",
    data: getAvailableModels().map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "microsoft",
    })),
  });
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse) {
  let token: string;
  try {
    token = await resolveToken(req);
  } catch (err: any) {
    return jsonResponse(res, 401, {
      error: { message: `Auth failed: ${err.message}`, type: "auth_error" },
    });
  }

  let body: ReturnType<typeof ChatCompletionRequest.parse>;
  try {
    const raw = await readBody(req);
    body = ChatCompletionRequest.parse(raw);
  } catch (err: any) {
    return jsonResponse(res, 400, {
      error: { message: `Invalid request: ${err.message}`, type: "invalid_request_error" },
    });
  }

  const text = formatMessages(body.messages);
  const streaming = body.stream;
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model;

  let stream;
  try {
    stream = await copilotChat(token, text, model);
  } catch (err: any) {
    return jsonResponse(res, 502, {
      error: { message: `M365 Copilot error: ${err.message}`, type: "upstream_error" },
    });
  }

  if (streaming) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    res.write(
      `data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}\n\n`,
    );

    try {
      for await (const delta of stream) {
        res.write(
          `data: ${JSON.stringify({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          })}\n\n`,
        );
      }
    } catch (err: any) {
      console.error("[server] Stream error:", err.message);
    }

    res.write(
      `data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    let fullText = "";
    try {
      for await (const delta of stream) {
        fullText += delta;
      }
      if (stream.fullText) fullText = stream.fullText;
    } catch (err: any) {
      return jsonResponse(res, 502, {
        error: { message: `M365 Copilot error: ${err.message}`, type: "upstream_error" },
      });
    }

    jsonResponse(res, 200, {
      id: completionId,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: fullText },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
}

// --- Server ---

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  const url = new URL(req.url!, `http://localhost:${PORT}`);

  try {
    if (url.pathname === "/health" && req.method === "GET") {
      jsonResponse(res, 200, { status: "ok" });
    } else if (url.pathname === "/v1/models" && req.method === "GET") {
      handleModels(req, res);
    } else if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      await handleChatCompletions(req, res);
    } else {
      jsonResponse(res, 404, { error: { message: "Not found", type: "not_found" } });
    }
  } catch (err: any) {
    console.error("[server] Unhandled error:", err);
    jsonResponse(res, 500, {
      error: { message: "Internal server error", type: "server_error" },
    });
  }
});

console.log("Authenticating...");
try {
  await getToken();
} catch (err: any) {
  console.error(`Auth failed: ${err.message}`);
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`M365 Copilot proxy listening on http://localhost:${PORT}`);
  console.log(`  POST /v1/chat/completions`);
  console.log(`  GET  /v1/models`);
  console.log(`  GET  /health`);
});
