import { splitWechatMessage } from "./chunking.js";

export interface StreamBufferOptions {
  intervalMs?: number;
  chunkSize?: number;
  send: (text: string) => Promise<void>;
}

export class StreamBuffer {
  private readonly intervalMs: number;
  private readonly chunkSize: number;
  private readonly send: (text: string) => Promise<void>;
  private buffer = "";
  private lastFlush = Date.now();

  constructor(options: StreamBufferOptions) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.chunkSize = options.chunkSize ?? 1800;
    this.send = options.send;
  }

  async append(text: string | undefined): Promise<void> {
    if (!text?.trim()) return;
    this.buffer += this.buffer ? `\n${text}` : text;
    await this.flush(false);
  }

  async flush(force: boolean): Promise<void> {
    if (!this.buffer.trim()) return;
    const now = Date.now();
    if (!force && now - this.lastFlush < this.intervalMs) return;

    const pending = this.buffer.trim();
    this.buffer = "";
    for (const chunk of splitWechatMessage(pending, this.chunkSize)) {
      await this.send(chunk);
      this.lastFlush = Date.now();
    }
  }
}
