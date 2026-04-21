export type AgentMode = "readonly" | "workspace" | "yolo";

export interface AgentTurnRequest {
  userId: string;
  prompt: string;
  cwd: string;
  mode: AgentMode;
  model?: string;
  codexSessionId?: string;
}

export interface AgentTurnResult {
  text: string;
  codexSessionId?: string;
  codexThreadId?: string;
  interrupted: boolean;
}

export interface AgentBackend {
  startTurn(
    request: AgentTurnRequest,
    callbacks: { onEvent?: (event: unknown, formatted?: string) => Promise<void> | void },
  ): Promise<AgentTurnResult>;
  resumeTurn(
    request: AgentTurnRequest,
    callbacks: { onEvent?: (event: unknown, formatted?: string) => Promise<void> | void },
  ): Promise<AgentTurnResult>;
  interrupt(userId: string): Promise<void>;
  formatEventForWechat(event: unknown): string | undefined;
}
