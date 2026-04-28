import type { AttachClientMessage, AttachCommandName } from "./protocol.js";

const KNOWN_COMMANDS = new Set<AttachCommandName>(["status", "project", "interrupt", "replace", "model", "models"]);

export function parseAttachInput(input: string, activeProject?: string): AttachClientMessage | undefined {
  const text = input.trim();
  if (!text) return undefined;
  if (!text.startsWith(":")) return { type: "prompt", project: activeProject, text: input };

  const commandText = text.slice(1);
  const match = /^(\S+)/.exec(commandText);
  const rawName = match?.[1] ?? "";
  const name = rawName.toLowerCase();
  const rest = commandText.slice(rawName.length).replace(/^\s+/, "");

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
      return { type: "command", project: rest.trim() || activeProject, name };
    case "replace":
      if (!rest.trim()) return undefined;
      return { type: "command", project: activeProject, name, text: rest };
    case "model":
      return { type: "command", project: activeProject, name, value: rest.trim() || undefined };
  }
}

function isAttachCommandName(name: string): name is AttachCommandName {
  return KNOWN_COMMANDS.has(name as AttachCommandName);
}
