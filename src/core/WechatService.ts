import type { AccountData } from "../config/accounts.js";
import type { BridgeSession } from "../session/types.js";
import type { WechatBindingStatus, WechatRuntimeStatus } from "./types.js";
import { SessionService } from "./SessionService.js";

export class WechatService {
  constructor(private readonly sessionService: SessionService) {}

  bindStatus(account: AccountData | null): WechatBindingStatus {
    if (!account) return { bound: false };
    return {
      bound: true,
      accountId: account.accountId,
      boundUserId: account.boundUserId,
      baseUrl: account.baseUrl,
      createdAt: account.createdAt,
    };
  }

  runtimeStatus(account: AccountData, session: BridgeSession): WechatRuntimeStatus {
    return {
      boundUserId: account.boundUserId,
      accountId: account.accountId,
      session: this.sessionService.status(session, account.boundUserId),
    };
  }
}
