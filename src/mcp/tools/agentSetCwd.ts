import { ok } from "../../core/errors.js";
import { ModeService } from "../../core/ModeService.js";
import type { BridgeTool } from "./types.js";
import { requireBoundSession, stringInput } from "./types.js";

export const agentSetCwdTool: BridgeTool = {
  name: "agent_set_cwd",
  description: "Set the current agent cwd to an allowlisted Git repo root.",
  async handler(context, input) {
    const { session, sessionStore } = requireBoundSession(context);
    const cwd = stringInput(input, "cwd") ?? "";
    const result = await new ModeService().setCwd(session, cwd);
    await sessionStore.save(session);
    return ok(result);
  },
};
