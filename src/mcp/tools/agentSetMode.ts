import { ok } from "../../core/errors.js";
import { ModeService } from "../../core/ModeService.js";
import type { BridgeTool } from "./types.js";
import { requireBoundSession, stringInput } from "./types.js";

export const agentSetModeTool: BridgeTool = {
  name: "agent_set_mode",
  description: "Set the current agent sandbox mode to readonly, workspace, or yolo.",
  async handler(context, input) {
    const { session, sessionStore } = requireBoundSession(context);
    const mode = stringInput(input, "mode") ?? "";
    const result = new ModeService().setMode(session, mode);
    await sessionStore.save(session);
    return ok(result);
  },
};
