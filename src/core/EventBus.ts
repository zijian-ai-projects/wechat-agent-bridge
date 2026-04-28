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

export interface EventBusOptions {
  maxQueuedEventsPerSubscriber?: number;
}

export class EventBus implements BridgeEventBus {
  private static readonly DEFAULT_MAX_QUEUED_EVENTS_PER_SUBSCRIBER = 1000;

  private readonly handlers = new Set<BridgeEventHandler>();
  private readonly queues = new Map<BridgeEventHandler, Promise<void>>();
  private readonly queuedCounts = new Map<BridgeEventHandler, number>();
  private readonly maxQueuedEventsPerSubscriber: number;

  constructor(options: EventBusOptions = {}) {
    this.maxQueuedEventsPerSubscriber =
      options.maxQueuedEventsPerSubscriber ?? EventBus.DEFAULT_MAX_QUEUED_EVENTS_PER_SUBSCRIBER;
  }

  subscribe(handler: BridgeEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
      this.queuedCounts.delete(handler);
    };
  }

  publish(event: BridgeEvent): Promise<void> {
    for (const handler of this.handlers) {
      this.enqueue(handler, event);
    }
    return Promise.resolve();
  }

  private enqueue(handler: BridgeEventHandler, event: BridgeEvent): void {
    const queuedCount = this.queuedCounts.get(handler) ?? 0;
    if (queuedCount >= this.maxQueuedEventsPerSubscriber && isDroppableEvent(event)) return;
    this.queuedCounts.set(handler, queuedCount + 1);

    const previous = this.queues.get(handler) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await handler(event);
      })
      .catch(() => undefined)
      .finally(() => {
        const currentCount = this.queuedCounts.get(handler) ?? 0;
        if (currentCount <= 1) {
          this.queuedCounts.delete(handler);
        } else {
          this.queuedCounts.set(handler, currentCount - 1);
        }
      });
    this.queues.set(handler, next);
    void next.finally(() => {
      if (this.queues.get(handler) === next) {
        this.queues.delete(handler);
      }
    });
  }
}

function isDroppableEvent(event: BridgeEvent): boolean {
  return event.type === "codex_event";
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
