import { randomUUID } from "node:crypto";

import { BridgeError, ok } from "../../core/errors.js";
import type { BridgeTool } from "./types.js";
import { requireBoundSession, stringInput } from "./types.js";

export const agentResumeTool: BridgeTool = {
  name: "agent_resume",
  description: "Run a prompt through the configured local agent backend using the current session.",
  async handler(context, input) {
    const { session, sessionStore } = requireBoundSession(context);
    const prompt = stringInput(input, "prompt");
    if (!prompt) throw new BridgeError("INVALID_ARGUMENT", "prompt is required");

    const turnId = randomUUID();
    session.state = "processing";
    session.activeTurnId = turnId;
    sessionStore.addHistory(session, "user", prompt);
    await sessionStore.save(session);

    try {
      const result = await context.agentService.runTurn({
        userId: session.userId,
        prompt,
        cwd: session.cwd,
        mode: session.mode,
        model: session.model,
        codexSessionId: session.codexSessionId,
        extraWritableRoots: context.extraWritableRoots ?? [],
      });

      if (result.clearedStaleSession) {
        session.codexSessionId = undefined;
        session.codexThreadId = undefined;
      }
      if (result.codexSessionId) session.codexSessionId = result.codexSessionId;
      if (result.codexThreadId) session.codexThreadId = result.codexThreadId;
      if (result.text) sessionStore.addHistory(session, "assistant", result.text);

      return ok({
        text: result.text,
        interrupted: result.interrupted,
        codexSessionId: session.codexSessionId,
        codexThreadId: session.codexThreadId,
      });
    } finally {
      if (session.activeTurnId === turnId) {
        session.state = "idle";
        session.activeTurnId = undefined;
        await sessionStore.save(session);
      }
    }
  },
};
