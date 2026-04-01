import { getToken } from "./auth.js";
import { getOrCreateAgent } from "./agent.js";
import { CopilotSession } from "./session.js";
import { createLogger } from "./log.js";
import type { CopilotStream } from "./copilot.js";

const log = createLogger("model");

export interface ModelSessionOptions {
  /** Pre-resolved auth token. If not provided, getToken() is called. */
  getToken?: () => Promise<string>;
  /** Whether to attempt agent resolution. Default: true. */
  useAgent?: boolean;
}

/**
 * A stateful session for running M365 Copilot.
 * Manages auth, agent resolution, and conversation continuity.
 * String in, stream out.
 *
 * The same sessionId and conversationId are reused across CopilotSession
 * reconnections so M365 finds the existing server-side conversation
 * instead of creating a new one.
 */
export class ModelSession {
  private resolveToken: () => Promise<string>;
  private useAgent: boolean;
  private copilotSession: CopilotSession | null = null;
  private cachedAgentId: string | null | undefined = undefined;

  /** Stable IDs reused across CopilotSession reconnections. */
  readonly sessionId: string = crypto.randomUUID();
  readonly conversationId: string = crypto.randomUUID();

  constructor(options: ModelSessionOptions = {}) {
    this.resolveToken = options.getToken ?? getToken;
    this.useAgent = options.useAgent !== false;
  }

  /** Number of turns completed in this session */
  get turnCount(): number {
    return this.copilotSession?.turnCount ?? 0;
  }

  private createCopilotSession(): CopilotSession {
    return new CopilotSession({
      agentId: this.cachedAgentId ?? undefined,
      sessionId: this.sessionId,
      conversationId: this.conversationId,
    });
  }

  /** Send text to M365 Copilot and stream back the response. */
  async run(text: string, model: string = "m365-copilot"): Promise<CopilotStream> {
    const token = await this.resolveToken();

    // Resolve agent ID lazily (persists across resets)
    if (this.useAgent && this.cachedAgentId === undefined) {
      try {
        this.cachedAgentId = await getOrCreateAgent();
        if (this.cachedAgentId) log.info(`Using agent: ${this.cachedAgentId}`);
        else log.info("No agent available");
      } catch {
        this.cachedAgentId = null;
      }
    }

    // Create session on first call or after reset
    if (!this.copilotSession) {
      this.copilotSession = this.createCopilotSession();
    }

    log.info(`run: model=${model}, turn=${this.copilotSession.turnCount}, sid=${this.sessionId}, cid=${this.conversationId}, text=${JSON.stringify(text.slice(0, 200))}`);

    try {
      return await this.copilotSession.chat(token, text, model);
    } catch (err: any) {
      // Session might be stale — reconnect with same IDs
      log.info("Session error, reconnecting:", err.message);
      this.copilotSession = this.createCopilotSession();
      return await this.copilotSession.chat(token, text, model);
    }
  }

  /** Reset the CopilotSession. Next run() reconnects with the same sessionId/conversationId. */
  reset() {
    this.copilotSession = null;
  }
}
