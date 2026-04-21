import { randomBytes, randomUUID } from "node:crypto";

import { DEFAULT_WECHAT_BASE_URL } from "../config/accounts.js";
import { logger } from "../logging/logger.js";
import type { GetUpdatesResp, SendMessageReq } from "./types.js";

const ALLOWED_BASE_HOSTS = ["weixin.qq.com", "wechat.com"];

export class WeChatApi {
  private readonly baseUrl: string;
  private readonly uin: string;

  constructor(private readonly token: string, baseUrl = DEFAULT_WECHAT_BASE_URL) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.uin = randomBytes(4).toString("base64");
  }

  async getUpdates(syncBuffer?: string): Promise<GetUpdatesResp> {
    return this.request<GetUpdatesResp>("ilink/bot/getupdates", syncBuffer ? { get_updates_buf: syncBuffer } : {}, 35_000);
  }

  async sendMessage(req: SendMessageReq): Promise<void> {
    await this.request("ilink/bot/sendmessage", req, 15_000);
  }

  newClientId(): string {
    return randomUUID();
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": this.uin,
    };
  }

  private async request<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = `${this.baseUrl}/${path}`;
    try {
      logger.debug("WeChat API request", { url, body });
      const response = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const allowed = ALLOWED_BASE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    if (url.protocol !== "https:" || !allowed) return DEFAULT_WECHAT_BASE_URL;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_WECHAT_BASE_URL;
  }
}
