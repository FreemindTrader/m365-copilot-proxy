import { serve } from "@hono/node-server";
import { getToken } from "@opencode-m365/core";
import { createApp } from "@opencode-m365/proxy-lib";

const PORT = parseInt(process.argv[2] || "4141", 10);

console.log("Authenticating...");
try {
  await getToken();
} catch (err: any) {
  console.error(`Auth failed: ${err.message}`);
  process.exit(1);
}

const app = createApp();

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`M365 Copilot proxy listening on http://localhost:${info.port}`);
  console.log(`  POST /v1/chat/completions  (with tool calling + agent mode)`);
  console.log(`  GET  /v1/models`);
  console.log(`  GET  /health`);
});
