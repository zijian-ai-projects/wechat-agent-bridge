import { ok } from "../../core/errors.js";
import { SessionService } from "../../core/SessionService.js";
import type { BridgeTool } from "./types.js";
import { requireBoundSession } from "./types.js";

export const sessionClearTool: BridgeTool = {
  name: "session_clear",
  description: "Interrupt the active agent turn and clear the current local session.",
  async handler(context) {
    const { account, session, sessionStore } = requireBoundSession(context);
    await context.agentService.interrupt(account.boundUserId);
    await new SessionService(sessionStore).clear(session, account.boundUserId);
    return ok({
      cleared: true,
      userId: session.userId,
      cwd: session.cwd,
      mode: session.mode,
    });
  },
};
