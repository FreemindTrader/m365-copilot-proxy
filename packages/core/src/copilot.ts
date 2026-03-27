import WebSocket from "ws";
import {
  SignalRHandshakeResponse,
  DeltaUpdate,
  MessageUpdate,
  ThrottlingUpdate,
  StreamItemFrame,
  CompletionFrame,
  PingFrame,
  CloseFrame,
  JwtClaims,
} from "./schemas.js";

import { createLogger } from "./log.js";

const RS = "\x1E";
const log = createLogger("copilot");

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

// Model name → tone mapping
const MODEL_TONES: Record<string, string> = {
  // Default
  "m365-copilot": "magic",
  "auto": "magic",

  // Generic modes
  "quick": "Gpt_Quick",
  "think-deeper": "Gpt_Reasoning",

  // GPT-5.4
  "gpt-5.4": "Gpt_5_4_Reasoning",
  "gpt-5.4-think-deeper": "Gpt_5_4_Reasoning",
  "gpt-5.4-quick": "Gpt_5_4_Quick",

  // GPT-5.3
  "gpt-5.3": "Gpt_5_3_Quick",
  "gpt-5.3-quick": "Gpt_5_3_Quick",
  "gpt-5.3-think-deeper": "Gpt_5_3_Reasoning",

  // GPT-5.2
  "gpt-5.2": "Gpt_5_2_Quick",
  "gpt-5.2-quick": "Gpt_5_2_Quick",
  "gpt-5.2-think-deeper": "Gpt_5_2_Reasoning",
};

export function getToneForModel(model: string): string {
  return MODEL_TONES[model] ?? MODEL_TONES["m365-copilot"];
}

export function getAvailableModels(): string[] {
  return Object.keys(MODEL_TONES);
}

export function decodeJwt(token: string) {
  const payload = token.split(".")[1];
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  const raw = JSON.parse(Buffer.from(padded, "base64").toString());
  return JwtClaims.parse(raw);
}

export interface CopilotStream {
  [Symbol.asyncIterator](): AsyncIterator<string>;
  fullText: string;
  /** True if the server returned content (deltas or full text) */
  hasContent: boolean;
  /** Throttle info if provided by M365 */
  throttle: { current: number; max: number } | null;
}

export interface CopilotChatOptions {
  /** Agent ID for custom Copilot Studio agents (e.g. "T_xxx.yyy.gpt.default") */
  agentId?: string;
}

export function copilotChat(token: string, text: string, model: string = "m365-copilot", options?: CopilotChatOptions): Promise<CopilotStream> {
  log.info(`Chat request: model=${model}, agent=${options?.agentId ?? "none"}, text=${JSON.stringify(text.slice(0, 200))}`);
  const claims = decodeJwt(token);
  const sessionId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();

  const params = new URLSearchParams({
    chatsessionid: sessionId,
    clientrequestid: sessionId,
    "X-SessionId": sessionId,
    ConversationId: conversationId,
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

  return new Promise((resolve, reject) => {
    let fullText = "";
    let deltaText = "";
    let receivedContent = false;
    let throttleInfo: { current: number; max: number } | null = null;
    let onDelta: ((text: string) => void) | null = null;
    let onDone: (() => void) | null = null;
    let onError: ((err: Error) => void) | null = null;

    const stream: CopilotStream = {
      get fullText() {
        // Prefer whichever is longer — deltaText is accumulated from streaming deltas,
        // fullText comes from MessageUpdate frames which may only have partial text
        return deltaText.length >= fullText.length ? deltaText : fullText;
      },
      get hasContent() {
        return receivedContent;
      },
      get throttle() {
        return throttleInfo;
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

    ws.on("open", () => {
      log.debug("WebSocket connected, sending handshake");
      ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      const raw = data.toString();
      log.debug("WS recv:", raw.slice(0, 500));
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
      log.info("WS closed, fullText length:", fullText.length);
      log.debug("Final response:", fullText.slice(0, 1000));
      onDone?.();
    });

    function sendChat() {
      const agentId = options?.agentId;

      const chatMsg = {
        arguments: [
          {
            source: "officeweb",
            clientCorrelationId: sessionId,
            sessionId,
            optionsSets: [] as string[],
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
            ],
            sliceIds: [] as string[],
            threadLevelGptId: agentId
              ? { id: agentId, source: "MOS3" }
              : {},
            traceId: sessionId,
            isStartOfSession: true,
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
              requestId: sessionId,
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
      log.debug("WS send:", payload.slice(0, 500));
      ws.send(payload);
      // Resolve with the stream now that we've sent the message
      resolve(stream);
    }

    function handleMsg(raw: unknown) {
      // Try to identify frame type
      const base = raw as { type?: number; target?: string; arguments?: unknown[] };

      if (base.type === 6) {
        // Ping - respond
        ws.send(JSON.stringify({ type: 6 }) + RS);
        return;
      }

      if (base.type === 7) {
        // Close
        const frame = CloseFrame.safeParse(raw);
        if (frame.success && frame.data.error) {
          onError?.(new Error(`Server close: ${frame.data.error}`));
        }
        ws.close();
        return;
      }

      if (base.type === 3) {
        // Completion
        const frame = CompletionFrame.safeParse(raw);
        if (frame.success && frame.data.error) {
          onError?.(new Error(`Completion error: ${frame.data.error}`));
        }
        ws.close();
        return;
      }

      if (base.type === 2) {
        // Stream item - conversation complete
        ws.close();
        return;
      }

      if (base.type === 1 && base.target === "update" && Array.isArray(base.arguments)) {
        for (const arg of base.arguments) {
          // Try delta update
          const delta = DeltaUpdate.safeParse(arg);
          if (delta.success) {
            receivedContent = true;
            deltaText += delta.data.writeAtCursor;
            onDelta?.(delta.data.writeAtCursor);
            continue;
          }

          // Try message update (contains full text)
          const msgUpdate = MessageUpdate.safeParse(arg);
          if (msgUpdate.success) {
            for (const m of msgUpdate.data.messages) {
              if (m.author === "bot" && m.text && !m.messageType) {
                receivedContent = true;
                fullText = m.text;
              }
            }
            continue;
          }

          // Try throttling
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
