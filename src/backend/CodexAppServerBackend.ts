import type { AgentBackend, AgentTurnRequest, AgentTurnResult } from "./AgentBackend.js";

export class CodexAppServerBackend implements AgentBackend {
  async startTurn(): Promise<AgentTurnResult> {
    throw new Error("CodexAppServerBackend is reserved for v2 and is not implemented in this MVP.");
  }

  async resumeTurn(): Promise<AgentTurnResult> {
    throw new Error("CodexAppServerBackend is reserved for v2 and is not implemented in this MVP.");
  }

  async interrupt(_userId: string): Promise<void> {
    return;
  }

  formatEventForWechat(_event: unknown): string | undefined {
    return undefined;
  }
}

export type ReservedCodexAppServerRequest = AgentTurnRequest;
