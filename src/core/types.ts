import type { AccountData } from "../config/accounts.js";
import type { BridgeSession } from "../session/types.js";

export interface TextSender {
  sendText(toUserId: string, contextToken: string, text: string): Promise<void>;
}

export interface SessionStorePort {
  save(session: BridgeSession): Promise<void>;
  clear(userId: string, defaults: { cwd: string; allowlistRoots: string[] }): Promise<BridgeSession>;
  addHistory(session: BridgeSession, role: "user" | "assistant", content: string): void;
  formatHistory(session: BridgeSession, limit?: number): string;
}

export interface SessionStatus {
  userId: string;
  boundUserId: string;
  state: BridgeSession["state"];
  cwd: string;
  allowlistRoots: string[];
  mode: BridgeSession["mode"];
  model?: string;
  codexSessionId?: string;
  codexThreadId?: string;
  activeTurnId?: string;
  historyCount: number;
  updatedAt: string;
}

export interface WechatBindingStatus {
  bound: boolean;
  accountId?: string;
  boundUserId?: string;
  baseUrl?: string;
  createdAt?: string;
}

export interface WechatRuntimeStatus {
  boundUserId: string;
  accountId: string;
  session: SessionStatus;
}

export interface LoadedBridgeContext {
  account: AccountData;
  session: BridgeSession;
}
