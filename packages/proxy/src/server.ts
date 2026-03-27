import { createProxyServer, getToken } from "@opencode-m365/core";

const PORT = parseInt(process.argv[2] || "4141", 10);

console.log("Authenticating...");
try {
  await getToken();
} catch (err: any) {
  console.error(`Auth failed: ${err.message}`);
  process.exit(1);
}

const proxy = await createProxyServer({ port: PORT });

console.log(`M365 Copilot proxy listening on http://localhost:${proxy.port}`);
console.log(`  POST /v1/chat/completions  (with tool calling + agent mode)`);
console.log(`  GET  /v1/models`);
console.log(`  GET  /health`);
