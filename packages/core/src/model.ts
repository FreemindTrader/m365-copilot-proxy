import { getToken } from "./auth.js";
import { getOrCreateAgent } from "./agent.js";
import { CopilotSession } from "./session.js";
import { createLogger, trunc } from "./log.js";
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

  /**
   * Send text to M365 Copilot and stream back the response.
   * If `signal` aborts (e.g. the HTTP client disconnects), the in-flight turn is
   * cancelled by sending M365's Stop frame, mirroring the real UI's Stop button.
   */
  async run(text: string, model: string = "m365-copilot", signal?: AbortSignal): Promise<CopilotStream> {
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

    log.info(`run: model=${model}, turn=${this.copilotSession.turnCount}, sid=${this.sessionId}, cid=${this.conversationId}, text=${JSON.stringify(trunc(text, 200))}`);

    try {
      return await this.copilotSession.chat(token, text, model, signal);
    } catch (err: any) {
      // Session might be stale — reconnect with same IDs
      log.info("Session error, reconnecting:", err.message);
      this.copilotSession = this.createCopilotSession();
      return await this.copilotSession.chat(token, text, model, signal);
    }
  }

  /**
   * Force a re-resolution of the tool-calling agent against the tenant and
   * reconnect if it changed. Recovers from the "deleted-agent trap": a
   * long-lived host caches its agent id for the whole process lifetime, so once
   * that agent is deleted from the tenant (e.g. by a newer-build's cleanup) it
   * would otherwise send `threadLevelGptId` at a dead bot forever and get empty
   * replies. Call this on an empty upstream reply before retrying. No-op when
   * the session isn't using an agent. Returns true if the agent id changed (and
   * the session was dropped to reconnect), so the caller can resend the original
   * prompt to the fresh agent.
   */
  async refreshAgent(): Promise<boolean> {
    if (!this.useAgent) return false;
    try {
      const fresh = await getOrCreateAgent({ forceRefresh: true });
      if (fresh !== this.cachedAgentId) {
        log.info(`Agent refreshed: ${this.cachedAgentId ?? "none"} -> ${fresh ?? "none"}`);
        this.cachedAgentId = fresh;
        this.copilotSession = null; // reconnect so the new agent id takes effect
        return true;
      }
    } catch (err: any) {
      log.info(`Agent refresh failed: ${err.message}`);
    }
    return false;
  }

  /**
   * Reset the CopilotSession. Next run() reconnects with the same
   * sessionId/conversationId. Also drops the cached agent id so the next run()
   * re-resolves it (cheap cache fast-path in the normal case).
   */
  reset() {
    this.copilotSession = null;
    this.cachedAgentId = undefined;
  }
}
