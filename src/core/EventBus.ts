import type { AgentMode } from "../backend/AgentBackend.js";
import type { SessionState } from "../session/types.js";

export type BridgePromptSource = "wechat" | "attach";
export type BridgeModelSource = "project override" | "codex config" | "unresolved";

export type BridgeEvent =
  | { type: "user_message"; source: BridgePromptSource; project: string; text: string; timestamp: string }
  | {
      type: "turn_started";
      source: BridgePromptSource;
      project: string;
      model: string;
      modelSource: BridgeModelSource;
      mode: AgentMode;
      timestamp: string;
    }
  | { type: "codex_event"; project: string; text: string; timestamp: string }
  | { type: "turn_completed"; project: string; text?: string; timestamp: string }
  | { type: "turn_failed"; project: string; message: string; timestamp: string }
  | {
      type: "state";
      project: string;
      state: SessionState;
      model: string;
      modelSource: BridgeModelSource;
      timestamp: string;
    };

export type BridgeEventHandler = (event: BridgeEvent) => void | Promise<void>;

export interface BridgeEventBus {
  publish(event: BridgeEvent): Promise<void>;
  subscribe(handler: BridgeEventHandler): () => void;
}

export class EventBus implements BridgeEventBus {
  private readonly handlers = new Set<BridgeEventHandler>();

  subscribe(handler: BridgeEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async publish(event: BridgeEvent): Promise<void> {
    await Promise.allSettled([...this.handlers].map(async (handler) => handler(event)));
  }
}

export class NullEventBus implements BridgeEventBus {
  subscribe(): () => void {
    return () => undefined;
  }

  async publish(): Promise<void> {
    return undefined;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
