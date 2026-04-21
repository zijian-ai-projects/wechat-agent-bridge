import type { AgentMode } from "../backend/AgentBackend.js";

export type SessionState = "idle" | "processing";

export interface ChatHistoryEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface BridgeSession {
  userId: string;
  state: SessionState;
  cwd: string;
  mode: AgentMode;
  model?: string;
  codexSessionId?: string;
  codexThreadId?: string;
  activeTurnId?: string;
  history: ChatHistoryEntry[];
  allowlistRoots: string[];
  updatedAt: string;
}

export interface SessionDefaults {
  cwd: string;
  allowlistRoots: string[];
  resetStaleProcessing?: boolean;
}
