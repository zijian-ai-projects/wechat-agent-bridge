import { logger } from "../logging/logger.js";
import { loadSyncBuffer, saveSyncBuffer } from "./syncBuffer.js";
import type { WeChatApi } from "./api.js";
import type { WeixinMessage } from "./types.js";

const SESSION_EXPIRED_CODE = -14;

export interface MonitorCallbacks {
  onMessage: (message: WeixinMessage) => Promise<void>;
  onSessionExpired: () => void;
}

export class WeChatMonitor {
  private readonly controller = new AbortController();
  private readonly recentIds = new Set<number>();

  constructor(
    private readonly api: WeChatApi,
    private readonly callbacks: MonitorCallbacks,
  ) {}

  async run(): Promise<void> {
    let failures = 0;
    while (!this.controller.signal.aborted) {
      try {
        const response = await this.api.getUpdates(loadSyncBuffer() || undefined);
        if (response.ret === SESSION_EXPIRED_CODE) {
          this.callbacks.onSessionExpired();
          await sleep(60 * 60 * 1000, this.controller.signal);
          continue;
        }
        if (response.get_updates_buf) saveSyncBuffer(response.get_updates_buf);

        for (const message of response.msgs ?? []) {
          if (message.message_id && this.recentIds.has(message.message_id)) continue;
          if (message.message_id) this.remember(message.message_id);
          this.callbacks.onMessage(message).catch((error) => {
            logger.error("Failed to handle WeChat message", {
              error: error instanceof Error ? error.message : String(error),
              messageId: message.message_id,
            });
          });
        }
        failures = 0;
      } catch (error) {
        if (this.controller.signal.aborted) break;
        failures += 1;
        logger.error("WeChat monitor polling failed", {
          error: error instanceof Error ? error.message : String(error),
          failures,
        });
        await sleep(failures >= 3 ? 30_000 : 3_000, this.controller.signal);
      }
    }
  }

  stop(): void {
    this.controller.abort();
  }

  private remember(messageId: number): void {
    this.recentIds.add(messageId);
    if (this.recentIds.size <= 1000) return;
    for (const id of Array.from(this.recentIds).slice(0, 500)) this.recentIds.delete(id);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
