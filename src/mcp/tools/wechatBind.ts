import { ok } from "../../core/errors.js";
import { SessionService } from "../../core/SessionService.js";
import { WechatService } from "../../core/WechatService.js";
import type { BridgeTool } from "./types.js";

const nullSessionStore = {
  async save(): Promise<void> {},
  async clear(): Promise<never> {
    throw new Error("session unavailable");
  },
  addHistory(): void {},
  formatHistory(): string {
    return "";
  },
};

export const wechatBindStatusTool: BridgeTool = {
  name: "wechat_bind_status",
  description: "Return whether this bridge has a bound WeChat account.",
  async handler(context) {
    const wechat = new WechatService(new SessionService(context.sessionStore ?? nullSessionStore));
    return ok(wechat.bindStatus(context.account));
  },
};
