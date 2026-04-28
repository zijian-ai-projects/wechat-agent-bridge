import type { AttachClientMessage, AttachCommandName } from "./protocol.js";

const KNOWN_COMMANDS = new Set<AttachCommandName>(["status", "project", "interrupt", "replace", "model", "models"]);

export function parseAttachInput(input: string, activeProject?: string): AttachClientMessage | undefined {
  const text = input.trim();
  if (!text) return undefined;
  if (!text.startsWith(":")) return { type: "prompt", project: activeProject, text: input };

  const [rawName = "", ...restParts] = text.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  const rest = restParts.join(" ").trim();

  if (!isAttachCommandName(name)) {
    return undefined;
  }

  switch (name) {
    case "status":
    case "models":
      return { type: "command", project: activeProject, name };
    case "project":
      return { type: "command", name, value: rest || undefined };
    case "interrupt":
      return { type: "command", project: rest || activeProject, name };
    case "replace":
      return { type: "command", project: activeProject, name, text: rest };
    case "model":
      return { type: "command", project: activeProject, name, value: rest || undefined };
  }
}

function isAttachCommandName(name: string): name is AttachCommandName {
  return KNOWN_COMMANDS.has(name as AttachCommandName);
}
