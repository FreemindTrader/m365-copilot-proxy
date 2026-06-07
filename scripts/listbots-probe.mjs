// Read-only probe: dump the raw Copilot Studio listBots response so we can see
// how the server reflects displayName -> shortBotName (the round-trip the
// hash-in-name versioning depends on). GET requests only — creates nothing.
// Usage: M365_NO_INTERACTIVE=1 node scripts/listbots-probe.mjs
process.env.M365_DEBUG = process.env.M365_DEBUG ?? "1";

import { getTokenForScope } from "../packages/core/dist/index.mjs";

const POWERPLATFORM_SCOPES = ["https://api.powerplatform.com/.default"];
const BAP_SCOPES = ["https://api.bap.microsoft.com/.default"];
const BAP_API = "https://api.bap.microsoft.com";

const ppHeaders = (token) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
  "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)",
});

const bapToken = await getTokenForScope(BAP_SCOPES);
const ppToken = await getTokenForScope(POWERPLATFORM_SCOPES);
console.log(`[probe] bap=${!!bapToken} pp=${!!ppToken}`);
if (!bapToken || !ppToken) process.exit(1);

// Discover the default environment (same logic as agent.ts).
const envRes = await fetch(
  `${BAP_API}/providers/Microsoft.BusinessAppPlatform/environments/~default?api-version=2023-06-01`,
  { headers: { Authorization: `Bearer ${bapToken}` } },
);
const env = await envRes.json();
const envId = env.name.replace(/^Default-/i, "").replace(/-/g, "").toLowerCase();
const base = `.df.environment.api.powerplatform.com`;
const candidates = [
  `https://default${envId}${base}`,
  `https://default${envId.slice(0, -2)}${base}`,
];

let envUrl = candidates[0];
for (const url of candidates) {
  const probe = await fetch(
    `${url}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`,
    { method: "HEAD", headers: { Authorization: `Bearer ${ppToken}` } },
  ).catch(() => null);
  if (probe) { envUrl = url; break; }
}
console.log(`[probe] envUrl=${envUrl}`);

const res = await fetch(
  `${envUrl}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`,
  { headers: ppHeaders(ppToken) },
);
console.log(`[probe] listBots status=${res.status}`);
const bots = await res.json();
// Show the full shape of one bot, plus the name fields for all of them.
console.log("[probe] === one full bot object ===");
console.log(JSON.stringify(Array.isArray(bots) ? bots[0] : bots, null, 2));
console.log("[probe] === name fields for all bots ===");
for (const b of Array.isArray(bots) ? bots : []) {
  console.log(JSON.stringify({
    botId: b.botId,
    shortBotName: b.shortBotName,
    displayName: b.displayName,
    name: b.name,
    schemaName: b.schemaName,
  }));
}
