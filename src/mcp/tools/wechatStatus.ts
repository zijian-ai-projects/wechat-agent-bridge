import { ok } from "../../core/errors.js";
import { SessionService } from "../../core/SessionService.js";
import { WechatService } from "../../core/WechatService.js";
import type { BridgeTool } from "./types.js";
import { requireBoundSession } from "./types.js";

export const wechatStatusTool: BridgeTool = {
  name: "wechat_status",
  description: "Return the current bound WeChat user and bridge session status.",
  async handler(context) {
    const { account, session, sessionStore } = requireBoundSession(context);
    const wechat = new WechatService(new SessionService(sessionStore));
    return ok(wechat.runtimeStatus(account, session));
  },
};
