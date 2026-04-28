import type { AgentMode } from "../backend/AgentBackend.js";
import type { SessionState } from "../session/types.js";

export type BridgePromptSource = "wechat";
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

interface EventSubscription {
  active: boolean;
  handler: BridgeEventHandler;
  pendingCount: number;
  processing: boolean;
  queue: BridgeEvent[];
}

export class EventBus implements BridgeEventBus {
  private static readonly DEFAULT_MAX_QUEUED_EVENTS_PER_SUBSCRIBER = 1000;

  private readonly subscriptions = new Set<EventSubscription>();
  private readonly maxQueuedEventsPerSubscriber: number;

  constructor(options: EventBusOptions = {}) {
    this.maxQueuedEventsPerSubscriber =
      options.maxQueuedEventsPerSubscriber ?? EventBus.DEFAULT_MAX_QUEUED_EVENTS_PER_SUBSCRIBER;
  }

  subscribe(handler: BridgeEventHandler): () => void {
    const subscription: EventSubscription = { active: true, handler, pendingCount: 0, processing: false, queue: [] };
    this.subscriptions.add(subscription);
    return () => {
      subscription.active = false;
      subscription.pendingCount = 0;
      subscription.queue = [];
      this.subscriptions.delete(subscription);
    };
  }

  publish(event: BridgeEvent): Promise<void> {
    for (const subscription of this.subscriptions) {
      this.enqueue(subscription, event);
    }
    return Promise.resolve();
  }

  private enqueue(subscription: EventSubscription, event: BridgeEvent): void {
    if (!subscription.active) return;
    if (subscription.pendingCount >= this.maxQueuedEventsPerSubscriber && isDroppableEvent(event)) return;
    subscription.pendingCount += 1;
    subscription.queue.push(event);
    if (subscription.processing) return;
    subscription.processing = true;
    queueMicrotask(() => void this.drain(subscription));
  }

  private async drain(subscription: EventSubscription): Promise<void> {
    while (subscription.active) {
      const event = subscription.queue.shift();
      if (!event) break;
      try {
        await subscription.handler(event);
      } catch {
        // Subscriber failures must not break later event delivery.
      } finally {
        subscription.pendingCount = Math.max(0, subscription.pendingCount - 1);
      }
    }
    subscription.processing = false;
    if (subscription.active && subscription.queue.length > 0) {
      subscription.processing = true;
      queueMicrotask(() => void this.drain(subscription));
    }
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
