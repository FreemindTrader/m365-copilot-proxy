import WebSocket from "ws";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  SignalRHandshakeResponse,
  DeltaUpdate,
  MessageUpdate,
  ThrottlingUpdate,
  CompletionFrame,
  CloseFrame,
} from "./schemas.js";
import { decodeJwt, getToneForModel, type CopilotStream } from "./copilot.js";
import { createLogger, trunc } from "./log.js";

const RS = "\x1E";
const log = createLogger("session");

// The exact frame the real m365.cloud.microsoft "Stop generating" button sends
// (captured June 2026, scripts/cancel-frame-capture.mjs). It's a normal type:1
// invocation with target "stop" and invocationId "1" (distinct from chat's "0"),
// sent on the same socket; the server acks with a type:3 completion and discards
// the partial answer. See docs/m365-copilot-api.md §6 and hypotheses.md F11.
const STOP_FRAME = JSON.stringify({ arguments: [{}], invocationId: "1", target: "stop", type: 1 }) + RS;

// Enabling these optionsSets unlocks M365's real server-side Python sandbox:
// the model writes and EXECUTES Python and returns true results (verified with a
// SHA-256 oracle — docs/hypotheses.md §8.9 / scripts/code-interpreter-probe.mjs).
// Applied only on the agent-less (plain-chat) path: the tool-calling agent wants
// the model to emit tool JSON, not run its own Python, so we leave that path
// untouched. Disable with M365_NO_CODE_INTERPRETER=1.
const CODE_INTERPRETER_OPTIONS_SETS = [
  "cwc_code_interpreter",
  "cwc_code_interpreter_amsfix",
  "cwc_code_interpreter_citation_fix",
  "code_interpreter_interactive_charts",
  "code_interpreter_matplotlib_patching",
];

// --- Optional per-request frame dumping for reverse engineering ---
// Enabled by M365_DUMP_FRAMES=1. Every SignalR frame received is appended to a
// per-request NDJSON file under ~/.config/opencode-m365/frames/. Cheap to run
// in production; gives us forensic data when M365 starts emitting new fields.
const DUMP_FRAMES = !!process.env.M365_DUMP_FRAMES;
const DUMP_DIR = join(homedir(), ".config", "opencode-m365", "frames");
function dumpFrame(requestId: string, parsed: unknown, direction: "recv" | "send") {
  if (!DUMP_FRAMES) return;
  try {
    mkdirSync(DUMP_DIR, { recursive: true });
    appendFileSync(
      join(DUMP_DIR, `${requestId}.ndjson`),
      JSON.stringify({ t: Date.now(), dir: direction, frame: parsed }) + "\n",
    );
  } catch {
    // best effort
  }
}

const VARIANTS = [
  "EnableMcpServerWidgets",
  "feature.EnableMcpServerWidgets",
  "feature.EnableLuForChatCIQ",
  "feature.enableChatCIQPlugin",
  "EnableRequestPlugins",
  "feature.EnableSensitivityLabels",
  "EnableUnsupportedUrlDetector",
  "feature.IsCustomEngineCopilotEnabled",
  "feature.bizchatfluxv3",
  "feature.enablechatpages",
  "feature.enableCodeCanvas",
  "feature.turnOnWorkTabRecommendation",
  "turnOffWorkTabUpsellFromClient",
  "feature.turnOnDARecommendation",
  "feature.IsStreamingModeInChatRequestEnabled",
  "IncludeSourceAttributionsConcise",
  "SkipPublishEmptyMessage",
  "feature.EnableDeduplicatingSourceAttributions",
  "Enable3PActionProgressMessages",
  "feature.enableClientWebRtc",
  "feature.EnableMeetingRecapOfSeriesMeetingWithCiq",
  "feature.EnableReferencesListCompleteSignal",
  "feature.StorageMessageSplitDisabled",
  "feature.EnableCuaTakeControlApi",
  "feature.cwcallowedos",
  "feature.disabledisallowedmsgs",
  "feature.enableCitationsForSynthesisData",
  "feature.enableGenerateGraphicArtOptionsSet",
  "cdximagen",
  "feature.EnableUpdatedUXForConfirmationDialog",
  "feature.EnableClientFileURLSupportForOfficeWebPaidCopilot",
  "feature.EnableDesignEditorImageGrounding",
  "feature.EnableDesignerEditor",
  "feature.OfficeWebToHelix",
  "feature.OfficeDesktopToHelix",
  "feature.M365TeamsHubToHelix",
  "feature.OwaHubToHelix",
  "feature.MonarchHubToHelix",
  "feature.Win32OutlookHubToHelix",
  "feature.MacOutlookHubToHelix",
  "Agt_bizchat_enableGpt5ForHelix",
].join(",");

export interface CopilotSessionOptions {
  agentId?: string;
  /** Reuse an existing session ID across reconnections. */
  sessionId?: string;
  /** Reuse an existing conversation ID so M365 finds the same server-side conversation. */
  conversationId?: string;
}

/**
 * A persistent conversation session with M365 Copilot.
 * Reuses the same sessionId/conversationId across turns,
 * reconnecting the WebSocket for each message.
 */
export class CopilotSession {
  private sessionId: string;
  private conversationId: string;
  private _turnCount = 0;
  private agentId?: string;

  constructor(options?: CopilotSessionOptions) {
    this.sessionId = options?.sessionId ?? crypto.randomUUID();
    this.conversationId = options?.conversationId ?? crypto.randomUUID();
    this.agentId = options?.agentId;
    log.info(`New session: sid=${this.sessionId}, cid=${this.conversationId}, agent=${this.agentId ?? "none"}`);
  }

  /** Number of turns completed in this session */
  get turnCount(): number {
    return this._turnCount;
  }

  /**
   * Send a message in this conversation and stream the response.
   * Each turn opens a fresh WebSocket with invocationId "0" (per SignalR protocol).
   * Session/conversation IDs are reused so M365 maintains server-side context.
   */
  chat(token: string, text: string, model: string = "m365-copilot", signal?: AbortSignal): Promise<CopilotStream> {
    const isFirst = this._turnCount === 0;
    this._turnCount++;

    log.info(`Chat turn ${this._turnCount - 1}: model=${model}, isFirst=${isFirst}, text=${JSON.stringify(trunc(text, 200))}`);

    const claims = decodeJwt(token);
    const requestId = crypto.randomUUID();

    const params = new URLSearchParams({
      chatsessionid: requestId,
      clientrequestid: requestId,
      "X-SessionId": this.sessionId,
      ConversationId: this.conversationId,
      access_token: token,
      variants: VARIANTS,
      source: '"officeweb"',
      product: "Office",
      agentHost: "Bizchat.FullScreen",
      licenseType: "Starter",
      agent: "web",
      scenario: "OfficeWebIncludedCopilot",
    });

    const wsUrl = `wss://substrate.office.com/m365Copilot/Chathub/${claims.oid}@${claims.tid}?${params}`;
    const agentId = this.agentId;
    const sessionId = this.sessionId;

    return new Promise((resolve, reject) => {
      let fullText = "";
      let deltaText = "";
      let receivedContent = false;
      let throttleInfo: { current: number; max: number } | null = null;
      let contentOrigin: string | null = null;
      let messageType: string | null = null;
      let messageId: string | null = null;
      // Highest per-component score across all messages this turn. The most
      // recent score isn't necessarily the most informative — the worst one is.
      const maxScores: Record<string, number> = {};
      let turnCountServer: number | null = null;
      let turnState: string | null = null;
      let onDelta: ((text: string) => void) | null = null;
      let onDone: (() => void) | null = null;
      let onError: ((err: Error) => void) | null = null;

      const stream: CopilotStream = {
        get fullText() {
          return deltaText.length >= fullText.length ? deltaText : fullText;
        },
        get hasContent() {
          return receivedContent;
        },
        get throttle() {
          return throttleInfo;
        },
        get contentOrigin() {
          return contentOrigin;
        },
        get messageType() {
          return messageType;
        },
        get messageId() {
          return messageId;
        },
        get scores() {
          return Object.keys(maxScores).length ? { ...maxScores } : null;
        },
        get turnCount() {
          return turnCountServer;
        },
        get turnState() {
          return turnState;
        },

        [Symbol.asyncIterator]() {
          const queue: string[] = [];
          let done = false;
          let error: Error | null = null;
          let waiting: {
            resolve: (result: IteratorResult<string>) => void;
            reject: (err: Error) => void;
          } | null = null;

          onDelta = (text: string) => {
            if (waiting) {
              const w = waiting;
              waiting = null;
              w.resolve({ value: text, done: false });
            } else {
              queue.push(text);
            }
          };

          onDone = () => {
            done = true;
            if (waiting) {
              const w = waiting;
              waiting = null;
              w.resolve({ value: undefined as any, done: true });
            }
          };

          onError = (err: Error) => {
            error = err;
            done = true;
            if (waiting) {
              const w = waiting;
              waiting = null;
              w.reject(err);
            }
          };

          return {
            next(): Promise<IteratorResult<string>> {
              if (error) return Promise.reject(error);
              if (queue.length > 0) {
                return Promise.resolve({ value: queue.shift()!, done: false });
              }
              if (done) {
                return Promise.resolve({ value: undefined as any, done: true });
              }
              return new Promise((res, rej) => {
                waiting = { resolve: res, reject: rej };
              });
            },
          };
        },
      };

      const ws = new WebSocket(wsUrl, {
        headers: {
          "Origin": "https://m365.cloud.microsoft",
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
        },
      });

      let handshakeDone = false;
      let stopped = false;

      // Cancellation: when the caller's signal aborts (HTTP client disconnected),
      // cancel the in-flight M365 turn the same way the real UI does — send the
      // Stop frame, then let the server's type:3 ack close the socket (with a
      // hard-close fallback). Before the handshake completes there's nothing to
      // stop, so just close.
      const onAbort = () => {
        if (stopped) return;
        stopped = true;
        try {
          if (ws.readyState === WebSocket.OPEN && handshakeDone) {
            log.info("Aborted — sending Stop frame to cancel the turn");
            dumpFrame(requestId, { target: "stop", type: 1 }, "send");
            ws.send(STOP_FRAME);
            setTimeout(() => { try { ws.close(); } catch {} }, 2_000);
          } else {
            try { ws.close(); } catch {}
          }
        } catch {
          try { ws.close(); } catch {}
        }
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      const clearAbort = () => signal?.removeEventListener("abort", onAbort);

      ws.on("open", () => {
        log.debug("WS connected, sending handshake");
        ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
      });

      ws.on("message", (data: WebSocket.RawData) => {
        const raw = data.toString();
        log.debug("WS recv:", trunc(raw, 500));
        const frames = raw.split(RS).filter((f) => f.length > 0);

        for (const frame of frames) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(frame);
          } catch {
            if (!handshakeDone) {
              handshakeDone = true;
              sendChat();
            }
            continue;
          }
          dumpFrame(requestId, parsed, "recv");

          if (!handshakeDone) {
            handshakeDone = true;
            const hs = SignalRHandshakeResponse.safeParse(parsed);
            if (hs.success && hs.data.error) {
              ws.close();
              reject(new Error(`Handshake error: ${hs.data.error}`));
              return;
            }
            sendChat();
            continue;
          }

          handleMsg(parsed);
        }
      });

      ws.on("error", (err: Error) => {
        const msg = err.message || "connection failed";
        log.error("WS error:", msg);
        if (!handshakeDone) {
          reject(new Error(`WebSocket error: ${msg}`));
        } else {
          onError?.(new Error(`WebSocket error: ${msg}`));
        }
      });

      ws.on("close", () => {
        clearAbort();
        log.info("WS closed, fullText length:", fullText.length);
        log.debug("Final response:", trunc(deltaText || fullText, 1000));
        onDone?.();
      });

      const sendChat = () => {
        const chatMsg = {
          arguments: [
            {
              source: "officeweb",
              clientCorrelationId: requestId,
              sessionId,
              // Code interpreter on the agent-less path only (see const above).
              // M365_EXTRA_OPTIONSSETS (comma-sep) merges in on ANY path — used to
              // test whether matching the official GUI's rich optionsSets stops the
              // agent-path "replace X→Y" Disengage (F17/F21). The GUI sends a rich
              // set + NO agent; we send [] + agent and Disengage.
              optionsSets: [
                ...((!agentId && !process.env.M365_NO_CODE_INTERPRETER) ? CODE_INTERPRETER_OPTIONS_SETS : []),
                ...(process.env.M365_EXTRA_OPTIONSSETS ? process.env.M365_EXTRA_OPTIONSSETS.split(",").map((s) => s.trim()).filter(Boolean) : []),
              ],
              streamingMode: "ConciseWithPadding",
              spokenTextMode: "None",
              options: {},
              extraExtensionParameters: {},
              allowedMessageTypes: [
                "Chat",
                "Suggestion",
                "InternalSearchQuery",
                "Disengaged",
                "InternalLoaderMessage",
                "Progress",
                "RenderCardRequest",
                "SemanticSerp",
                "GenerateContentQuery",
                "SearchQuery",
                "ConfirmationCard",
                "DeveloperLogs",
                "EndOfRequest",
                "ReferencesListComplete",
                "GeneratedCode",        // code-interpreter execution frames
                "GenerateContentQuery",
              ],
              sliceIds: [] as string[],
              threadLevelGptId: agentId
                ? { id: agentId, source: "MOS3" }
                : {},
              traceId: requestId,
              isStartOfSession: isFirst,
              clientInfo: {
                clientPlatform: "mcmcopilot-web",
                clientAppName: "Office",
                clientEntrypoint: "mcmcopilot-officeweb",
                clientSessionId: sessionId,
                clientAppType: "Web",
                deviceOS: "Linux",
                deviceType: "Desktop",
              },
              message: {
                author: "user",
                inputMethod: "Keyboard",
                text,
                entityAnnotationTypes: [
                  "People",
                  "File",
                  "Event",
                  "Email",
                  "TeamsMessage",
                ],
                requestId,
                locationInfo: { timeZoneOffset: 1, timeZone: "Europe/Copenhagen" },
                locale: "en-gb",
                messageType: "Chat",
                experienceType: "Default",
                adaptiveCards: [] as any[],
                clientPreferences: {},
              },
              ...(agentId
                ? {
                    gpts: [{
                      id: agentId,
                      source: "MOS3",
                      version: "1.0.0",
                      clientOverrides: {
                        capabilities: [],
                        "deepResearchModels@odata.type": "Collection(String)",
                      },
                    }],
                  }
                : {
                    plugins: [{ Id: "BingWebSearch", Source: "BuiltIn" }],
                  }),
              isSbsSupported: true,
              tone: getToneForModel(model),
              renderReferencesBehindEOS: true,
              disconnectBehavior: "continue",
            },
          ],
          invocationId: "0",
          target: "chat",
          type: 4,
        };

        const metrics = {
          arguments: [
            {
              Timestamps: {
                ConnectionStart: new Date().toISOString(),
                UserInputStart: new Date().toISOString(),
                ConnectionEstablished: new Date().toISOString(),
                UserInputSubmit: new Date().toISOString(),
              },
            },
          ],
          target: "Metrics",
          type: 1,
        };

        const payload = JSON.stringify(chatMsg) + RS + JSON.stringify(metrics) + RS;
        log.debug("WS send:", trunc(payload, 500));
        dumpFrame(requestId, chatMsg, "send");
        dumpFrame(requestId, metrics, "send");
        ws.send(payload);
        resolve(stream);
      };

      function handleMsg(raw: unknown) {
        const base = raw as { type?: number; target?: string; arguments?: unknown[] };

        if (base.type === 6) {
          ws.send(JSON.stringify({ type: 6 }) + RS);
          return;
        }

        if (base.type === 7) {
          const frame = CloseFrame.safeParse(raw);
          if (frame.success && frame.data.error) {
            onError?.(new Error(`Server close: ${frame.data.error}`));
          }
          ws.close();
          return;
        }

        if (base.type === 3) {
          const frame = CompletionFrame.safeParse(raw);
          if (frame.success && frame.data.error) {
            onError?.(new Error(`Completion error: ${frame.data.error}`));
          }
          ws.close();
          return;
        }

        if (base.type === 2) {
          // Stream item — the FINAL state of the conversation, with authoritative
          // throttle/turnCount/scores. Mine it before closing.
          const item = (raw as { item?: { messages?: any[]; throttling?: any; turnState?: string } }).item;
          if (item) {
            if (item.turnState) turnState = item.turnState;
            if (item.throttling) {
              throttleInfo = { current: item.throttling.numUserMessagesInConversation, max: item.throttling.maxNumUserMessagesInConversation };
            }
            for (const m of item.messages ?? []) {
              if (m.author !== "bot") continue;
              if (m.contentOrigin) contentOrigin = m.contentOrigin;
              if (m.messageType) messageType = m.messageType;
              if (m.messageId) messageId = m.messageId;
              if (typeof m.turnCount === "number") turnCountServer = m.turnCount;
              if (Array.isArray(m.scores)) {
                for (const s of m.scores) {
                  if (typeof s?.component !== "string" || typeof s?.score !== "number") continue;
                  if (!(s.component in maxScores) || s.score > maxScores[s.component]) {
                    maxScores[s.component] = s.score;
                  }
                }
              }
            }
          }
          ws.close();
          return;
        }

        if (base.type === 1 && base.target === "update" && Array.isArray(base.arguments)) {
          for (const arg of base.arguments) {
            const delta = DeltaUpdate.safeParse(arg);
            if (delta.success) {
              receivedContent = true;
              deltaText += delta.data.writeAtCursor;
              onDelta?.(delta.data.writeAtCursor);
              continue;
            }

            const msgUpdate = MessageUpdate.safeParse(arg);
            if (msgUpdate.success) {
              for (const m of msgUpdate.data.messages) {
                // Capture diagnostic meta from every bot message — including the
                // control-typed ones — so callers can tell apart `DeepLeo` from
                // `3PDeclarativeAgent` and surface `Disengaged` cleanly.
                if (m.author === "bot") {
                  if (m.contentOrigin) contentOrigin = m.contentOrigin;
                  if (m.messageType) messageType = m.messageType;
                  if (m.messageId) messageId = m.messageId;
                  if (m.scores) {
                    for (const s of m.scores) {
                      if (!(s.component in maxScores) || s.score > maxScores[s.component]) {
                        maxScores[s.component] = s.score;
                      }
                    }
                  }
                  if (typeof m.turnCount === "number") turnCountServer = m.turnCount;
                  if (m.turnState) turnState = m.turnState;
                }
                if (m.author === "bot" && m.text && !m.messageType) {
                  receivedContent = true;
                  fullText = m.text;
                }
              }
              continue;
            }

            const throttle = ThrottlingUpdate.safeParse(arg);
            if (throttle.success) {
              const t = throttle.data.throttling;
              throttleInfo = { current: t.numUserMessagesInConversation, max: t.maxNumUserMessagesInConversation };
              log.info(`Throttle: ${t.numUserMessagesInConversation}/${t.maxNumUserMessagesInConversation} messages`);
            }
          }
        }
      }
    });
  }
}
