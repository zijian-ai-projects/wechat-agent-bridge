import { BridgeError, ok } from "../../core/errors.js";
import { SessionService } from "../../core/SessionService.js";
import type { BridgeTool } from "./types.js";
import { numberInput, requireBoundSession } from "./types.js";

export const wechatHistoryTool: BridgeTool = {
  name: "wechat_history",
  description: "Return recent bridge conversation history as text.",
  async handler(context, input) {
    const { session, sessionStore } = requireBoundSession(context);
    const limit = numberInput(input, "limit") ?? 20;
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new BridgeError("INVALID_ARGUMENT", "limit must be a positive integer");
    }
    return ok({
      limit,
      text: new SessionService(sessionStore).history(session, limit),
    });
  },
};
