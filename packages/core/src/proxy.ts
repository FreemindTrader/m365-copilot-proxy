import { createServer, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { getAvailableModels } from "./copilot.js";
import { ChatCompletionRequest } from "./schemas.js";
import { getToken } from "./auth.js";
import { handleChatCompletion, HandlerContext, createHandlerContext } from "./handler.js";
import { createLogger } from "./log.js";

const log = createLogger("proxy");

export interface ProxyOptions {
  /** Port to listen on. 0 = random available port. */
  port?: number;
  /** Pre-resolved auth token. If not provided, getToken() is called per-request. */
  getToken?: () => Promise<string>;
  /** Whether to attempt agent resolution. Default: true. */
  useAgent?: boolean;
}

export interface ProxyServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/** Bridge a Web API Response to a Node.js ServerResponse */
async function sendWebResponse(webRes: Response, nodeRes: ServerResponse) {
  const headers: Record<string, string> = { "Access-Control-Allow-Origin": "*" };
  webRes.headers.forEach((value, key) => { headers[key] = value; });
  nodeRes.writeHead(webRes.status, headers);

  if (webRes.body) {
    // Convert Web ReadableStream to Node.js Readable and pipe
    const nodeStream = Readable.fromWeb(webRes.body as any);
    nodeStream.pipe(nodeRes);
  } else {
    nodeRes.end(await webRes.text());
  }
}

/**
 * Create and start the M365 proxy HTTP server.
 * Delegates to handleChatCompletion() for session reuse, delta messages,
 * tool calling, and agent mode.
 */
export async function createProxyServer(options: ProxyOptions = {}): Promise<ProxyServer> {
  const resolveToken = options.getToken ?? getToken;
  const useAgent = options.useAgent !== false;
  const ctx = createHandlerContext();

  const server = createServer(async (req, res) => {
    const jsonRes = (status: number, body: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(body));
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      return res.end();
    }

    const url = new URL(req.url!, `http://localhost`);
    log.info(`${req.method} ${url.pathname}`);

    try {
      if (url.pathname === "/health" && req.method === "GET") {
        return jsonRes(200, { status: "ok" });
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        const created = Math.floor(Date.now() / 1000);
        return jsonRes(200, {
          object: "list",
          data: getAvailableModels().map((id) => ({
            id,
            object: "model",
            created,
            owned_by: "microsoft",
          })),
        });
      }

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        let body: ReturnType<typeof ChatCompletionRequest.parse>;
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          body = ChatCompletionRequest.parse(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (err: any) {
          return jsonRes(400, { error: { message: err.message, type: "invalid_request_error" } });
        }

        const webRes = await handleChatCompletion(body, {
          getToken: resolveToken,
          useAgent,
          context: ctx,
        });

        await sendWebResponse(webRes, res);
        return;
      }

      jsonRes(404, { error: { message: "Not found", type: "not_found" } });
    } catch (err: any) {
      log.error("Unhandled error:", err.message);
      jsonRes(500, { error: { message: "Internal server error", type: "server_error" } });
    }
  });

  const port = options.port ?? 0;

  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      log.info(`Proxy server started on port ${actualPort}`);
      resolve({
        server,
        port: actualPort,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
