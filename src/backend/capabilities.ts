export type AgentBackendId = "codex" | "claude" | "cursor";

export interface AgentBackendCapabilities {
  id: AgentBackendId;
  displayName: string;
  available: boolean;
  supportsResume: boolean;
  supportsInterrupt: boolean;
  notes: string;
}

const CAPABILITIES: Record<AgentBackendId, AgentBackendCapabilities> = {
  codex: {
    id: "codex",
    displayName: "Codex CLI",
    available: true,
    supportsResume: true,
    supportsInterrupt: true,
    notes: "v1 runnable backend implemented by CodexExecBackend.",
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    available: false,
    supportsResume: false,
    supportsInterrupt: false,
    notes: "Reserved extension point; use integrations/claude templates with MCP until a real backend is implemented.",
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor Agent",
    available: false,
    supportsResume: false,
    supportsInterrupt: false,
    notes: "Reserved extension point; use integrations/cursor templates with MCP until a real backend is implemented.",
  },
};

export function getBackendCapabilities(id: AgentBackendId): AgentBackendCapabilities {
  return CAPABILITIES[id];
}

export function listBackendCapabilities(): AgentBackendCapabilities[] {
  return Object.values(CAPABILITIES);
}
