import { describe, it, expect, vi } from "vitest";

// Always-reinject regression tests (docs/always-reinject-report.md).
//
// Contract under test: a request that carries `tools` and tool_choice != "none"
// must present the <tools> definitions block in EVERY outbound M365 prompt —
// turn 1 (full framing) and every follow-up delta turn alike. OpenAI tool
// semantics: the toolset is restated per request, never left to M365's memory
// of a previous turn's framing.
//
// The handler is exercised end-to-end with core's ModelSession replaced by a
// scripted fake (same approach as streaming.test.ts): no auth, no WebSocket,
// everything else real. Every outbound prompt lands in `scripted.texts`.

const scripted: {
  deltas: string[];
  fullText: string;
  runs: number;
  /** Text of every run() call, in order — the outbound M365 prompts. */
  texts: string[];
  sessionsMade: number;
  /** Which fake session (by creation order) served every run() call. */
  servedBy: number[];
  /** How many times newConversation() was called on any session. */
  newConversations: number;
} = { deltas: [], fullText: "", runs: 0, texts: [], sessionsMade: 0, servedBy: [], newConversations: 0 };

vi.mock("@m365-copilot/core", async (importActual) => {
  const actual = await importActual<typeof import("@m365-copilot/core")>();
  class FakeModelSession {
    readonly uid = ++scripted.sessionsMade;
    turnCount = 0;
    conversationId = "conv-test";
    reset() {}
    newConversation() {
      this.conversationId = `conv-test-${scripted.newConversations++}`;
      this.turnCount = 0;
    }
    async refreshAgent() { return false; }
    async run(
      text: string,
      _model?: string,
      _signal?: AbortSignal,
      _useAgent?: boolean,
      _images: string[] = [],
      _waitForBudget?: () => Promise<unknown>,
    ) {
      this.turnCount++; // like the real session: later requests go down the delta path
      scripted.runs++;
      scripted.texts.push(text);
      scripted.servedBy.push(this.uid);
      const full = scripted.fullText;
      const stream = {
        get fullText() { return full; },
        hasContent: full.length > 0,
        result: { value: "Success" },
        metering: null,
        images: [],
        throttle: { current: 1, max: 600 },
        contentOrigin: "Claude",
        messageType: null as string | null,
        messageId: "m1",
        scores: null,
        turnCount: 1,
        turnState: "Completed",
        async *[Symbol.asyncIterator]() {
          yield full;
        },
      };
      return stream;
    }
  }
  // awaitTurnBudget reads the account's real logs; script its verdict instead.
  async function awaitTurnBudget(_opts: { maxWaitMs?: number; signal?: AbortSignal } = {}) {
    return { waitedMs: 0 };
  }
  return { ...actual, ModelSession: FakeModelSession, awaitTurnBudget };
});

const { handleChatCompletion, SessionPool, ChatCompletionRequest } = await import("./index.js");
const {
  formatMessages,
  formatToolsBlock,
  defaultFramingForModel,
  currentFramingVariant,
} = await import("@m365-copilot/core");

// --- Fixtures ---

const bashTool = {
  type: "function",
  function: {
    name: "bash",
    description: "Execute a bash command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

const writeTool = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
};

const baseMessages = [
  { role: "system", content: "You are a coding agent." },
  { role: "user", content: "List the files in the working directory." },
];

/** Append one assistant tool call + its tool result, the way a harness does. */
function withToolResult(
  messages: ReturnType<typeof ChatCompletionRequest.parse>["messages"],
  callId: string,
): typeof messages {
  return [
    ...messages,
    {
      role: "assistant" as const,
      tool_calls: [{
        id: callId,
        type: "function" as const,
        function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) },
      }],
    },
    {
      role: "tool" as const,
      tool_call_id: callId,
      name: "bash",
      content: "file1.txt\nfile2.txt",
    },
  ];
}

/** The model's reply: one real fenced tool call, so no forcing retries fire. */
const TOOL_CALL_REPLY = "```bash\nls\n```";

/** One non-streaming request on the shared pool with the scripted reply. */
async function respond(body: ReturnType<typeof ChatCompletionRequest.parse>, pool?: SessionPool): Promise<Response> {
  scripted.fullText = TOOL_CALL_REPLY;
  return handleChatCompletion(body, pool ?? new SessionPool());
}

// --- Tests ---

describe("always-reinject tools", () => {
  it("T1: turn 1 outbound prompt contains the <tools> block", async () => {
    scripted.texts = [];
    const body = ChatCompletionRequest.parse({
      messages: baseMessages,
      tools: [bashTool],
    });
    const resp = await respond(body);
    expect(resp.status).toBe(200);
    expect(scripted.texts).toHaveLength(1);
    expect(scripted.texts[0]).toContain("<tools>");
    expect(scripted.texts[0]).toContain("</tools>");
    // The block names the actual tool, not just the tag.
    expect(scripted.texts[0]).toContain("bash");
  });

  it("T2: turn 2 outbound prompt contains <tools> AND the <tool_response>", async () => {
    const pool = new SessionPool();
    scripted.texts = [];
    const turn1 = ChatCompletionRequest.parse({ messages: baseMessages, tools: [bashTool] });
    await respond(turn1, pool);

    const messages2 = withToolResult(baseMessages, "call_1");
    const turn2 = ChatCompletionRequest.parse({ messages: messages2, tools: [bashTool] });
    await respond(turn2, pool);

    expect(scripted.texts).toHaveLength(2);
    expect(scripted.texts[1]).toContain("<tools>");
    expect(scripted.texts[1]).toContain("</tools>");
    expect(scripted.texts[1]).toContain("<tool_response");
    // Delta content survives the reinjection prefix.
    expect(scripted.texts[1]).toContain("file1.txt");
    // The tools block rides AHEAD of the delta.
    expect(scripted.texts[1].indexOf("<tools>")).toBeLessThan(scripted.texts[1].indexOf("<tool_response"));
  });

  it("T3: 100-turn loop — EVERY outbound prompt contains <tools>", async () => {
    const pool = new SessionPool();
    scripted.texts = [];
    let messages = baseMessages as ReturnType<typeof ChatCompletionRequest.parse>["messages"];
    for (let turn = 1; turn <= 100; turn++) {
      const body = ChatCompletionRequest.parse({ messages, tools: [bashTool] });
      const resp = await respond(body, pool);
      expect(resp.status).toBe(200);
      messages = withToolResult(messages, `call_${turn}`);
    }
    expect(scripted.texts).toHaveLength(100);
    const missing = scripted.texts
      .map((t, i) => (t.includes("<tools>") && t.includes("</tools>") ? null : i + 1))
      .filter(Boolean);
    expect(missing).toEqual([]);
    // Every tool-result turn also carries its named <tool_response>.
    for (const t of scripted.texts.slice(1)) {
      expect(t).toContain("<tool_response");
    }
  });

  it("T4: request without tools never injects <tools>", async () => {
    scripted.texts = [];
    const body = ChatCompletionRequest.parse({ messages: baseMessages });
    const resp = await respond(body);
    expect(resp.status).toBe(200);
    expect(scripted.texts).toHaveLength(1);
    expect(scripted.texts[0]).not.toContain("<tools>");
    // The user message still went out.
    expect(scripted.texts[0]).toContain("List the files");
  });

  it("T5: tool_choice=none never injects <tools>", async () => {
    scripted.texts = [];
    const body = ChatCompletionRequest.parse({
      messages: baseMessages,
      tools: [bashTool],
      tool_choice: "none",
    });
    const resp = await respond(body);
    expect(resp.status).toBe(200);
    expect(scripted.texts).toHaveLength(1);
    expect(scripted.texts[0]).not.toContain("<tools>");
    expect(scripted.texts[0]).toContain("List the files");
  });

  it("T6: turn 1 prompt is byte-for-byte unchanged by the fix", async () => {
    scripted.texts = [];
    const body = ChatCompletionRequest.parse({ messages: baseMessages, tools: [bashTool] });
    await respond(body);
    // The fake session's conversationId before the first run is "conv-test";
    // the handler resolves the framing variant exactly as documented in
    // handleChatCompletion (env override → model default).
    const variant = currentFramingVariant(defaultFramingForModel(body.model));
    const expected = formatMessages(body.messages, body.tools, body.tool_choice, "conv-test", variant);
    expect(scripted.texts[0]).toBe(expected);
  });

  it("T7: changed toolset — fresh conversation, new definitions in the prompt", async () => {
    const pool = new SessionPool();
    scripted.texts = [];
    scripted.servedBy = [];
    const firstUid = scripted.sessionsMade + 1; // next session this pool creates
    const toolsA = [bashTool];
    const toolsB = [bashTool, writeTool];

    const turn1 = ChatCompletionRequest.parse({ messages: baseMessages, tools: toolsA });
    await respond(turn1, pool);
    expect(scripted.servedBy).toEqual([firstUid]);
    expect(scripted.texts[0]).not.toContain("write_file");

    // A different tool NAME set changes the session-pool fingerprint → a fresh
    // M365 conversation with the full history, now carrying BOTH definitions.
    const messages2 = withToolResult(baseMessages, "call_1");
    const turn2 = ChatCompletionRequest.parse({ messages: messages2, tools: toolsB });
    await respond(turn2, pool);
    expect(scripted.servedBy).toEqual([firstUid, firstUid + 1]); // a new ModelSession served it
    expect(scripted.texts[1]).toContain("<tools>");
    expect(scripted.texts[1]).toContain("bash");
    expect(scripted.texts[1]).toContain("write_file");
  });

  it("reinjection uses the same serializer as the turn-1 framing block", async () => {
    // The delta path must not grow a second tool serialization: the standalone
    // block must be a substring of what the turn-1 framing renders. On Windows
    // the block carries the host-platform note after </tools>; on other hosts
    // it ends at the closing tag.
    const block = formatToolsBlock([bashTool, writeTool]);
    expect(block.startsWith("<tools>\n")).toBe(true);
    expect(block).toContain("</tools>");
    const full = formatMessages(baseMessages, [bashTool, writeTool], undefined, "conv-test", "baseline");
    expect(full).toContain(block);
  });
});
