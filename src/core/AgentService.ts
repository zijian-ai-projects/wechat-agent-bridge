import type { AgentBackend, AgentTurnRequest, AgentTurnResult } from "../backend/AgentBackend.js";

export interface AgentRunResult extends AgentTurnResult {
  clearedStaleSession: boolean;
}

export interface AgentCallbacks {
  onEvent?: (event: unknown, formatted?: string) => Promise<void> | void;
}

export class AgentService {
  constructor(private readonly backend: AgentBackend) {}

  async runTurn(request: AgentTurnRequest, callbacks: AgentCallbacks = {}): Promise<AgentRunResult> {
    if (!request.codexSessionId) {
      const result = await this.backend.startTurn({ ...request, codexSessionId: undefined }, callbacks);
      return { ...result, clearedStaleSession: false };
    }

    const resumed = await this.backend.resumeTurn(request, callbacks);
    if (!resumed.interrupted && !resumed.text && !resumed.codexSessionId) {
      const fresh = await this.backend.startTurn({ ...request, codexSessionId: undefined }, callbacks);
      return { ...fresh, clearedStaleSession: true };
    }

    return { ...resumed, clearedStaleSession: false };
  }

  async interrupt(executionKey: string): Promise<void> {
    await this.backend.interrupt(executionKey);
  }

  formatEventForWechat(event: unknown): string | undefined {
    return this.backend.formatEventForWechat(event);
  }
}
