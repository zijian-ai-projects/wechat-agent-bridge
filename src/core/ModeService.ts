import type { AgentMode } from "../backend/AgentBackend.js";
import { resolveAllowedRepoRoot } from "../config/git.js";
import type { BridgeSession } from "../session/types.js";
import { BridgeError } from "./errors.js";

const MODES: AgentMode[] = ["readonly", "workspace", "yolo"];

export class ModeService {
  setMode(session: BridgeSession, mode: string): { mode: AgentMode; warning?: string } {
    if (!MODES.includes(mode as AgentMode)) {
      throw new BridgeError("INVALID_ARGUMENT", `未知模式: ${mode}. 可用: ${MODES.join(", ")}`);
    }
    session.mode = mode as AgentMode;
    return {
      mode: session.mode,
      warning: session.mode === "yolo" ? "yolo 会绕过 Codex sandbox 和审批，只应在信任任务与工作目录时使用。" : undefined,
    };
  }

  setModel(session: BridgeSession, model: string | undefined): { model?: string } {
    const next = model?.trim();
    session.model = next || undefined;
    return { model: session.model };
  }

  async setCwd(session: BridgeSession, cwd: string): Promise<{ cwd: string }> {
    try {
      session.cwd = await resolveAllowedRepoRoot(cwd, session.allowlistRoots);
      return { cwd: session.cwd };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BridgeError("INVALID_ARGUMENT", message);
    }
  }

  availableModes(): AgentMode[] {
    return [...MODES];
  }
}
