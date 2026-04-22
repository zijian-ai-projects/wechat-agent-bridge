import type { AgentBackend, AgentTurnRequest, AgentTurnResult } from "./AgentBackend.js";

export class CursorAgentBackend implements AgentBackend {
  async startTurn(_request: AgentTurnRequest): Promise<AgentTurnResult> {
    throw new Error("CursorAgentBackend is an extension point and is not implemented in v1.");
  }

  async resumeTurn(_request: AgentTurnRequest): Promise<AgentTurnResult> {
    throw new Error("CursorAgentBackend is an extension point and is not implemented in v1.");
  }

  async interrupt(_userId: string): Promise<void> {
    return;
  }

  formatEventForWechat(_event: unknown): string | undefined {
    return undefined;
  }
}
