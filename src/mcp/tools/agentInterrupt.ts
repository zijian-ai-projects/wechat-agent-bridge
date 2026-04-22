import { ok } from "../../core/errors.js";
import type { BridgeTool } from "./types.js";
import { requireBoundSession } from "./types.js";

export const agentInterruptTool: BridgeTool = {
  name: "agent_interrupt",
  description: "Interrupt the active local agent turn for the bound user.",
  async handler(context) {
    const { account, session, sessionStore } = requireBoundSession(context);
    await context.agentService.interrupt(account.boundUserId);
    session.state = "idle";
    session.activeTurnId = undefined;
    await sessionStore.save(session);
    return ok({ interrupted: true, userId: account.boundUserId });
  },
};
