import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";

export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith(`~${sep}`) || input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return input;
}

export function validateStorageId(value: string, label = "id"): void {
  if (!/^[a-zA-Z0-9_.@=-]+$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

export async function resolveAllowedCwd(inputPath: string, allowlistRoots: string[]): Promise<string> {
  if (!inputPath.trim()) throw new Error("Path is required");
  if (allowlistRoots.length === 0) throw new Error("No allowlist roots configured");

  const expanded = expandHome(inputPath.trim());
  const absolute = isAbsolute(expanded) ? normalize(expanded) : resolve(process.cwd(), expanded);
  const candidate = await realpath(absolute);
  const allowedRoots = await Promise.all(
    allowlistRoots.map(async (root) => realpath(isAbsolute(expandHome(root)) ? expandHome(root) : resolve(expandHome(root)))),
  );

  for (const root of allowedRoots) {
    if (candidate === root || candidate.startsWith(`${root}${sep}`)) {
      return candidate;
    }
  }

  throw new Error(`Path is not within an allowed root: ${candidate}`);
}

export function isDirectBoundUserMessage(params: {
  fromUserId?: string;
  boundUserId: string;
  messageType?: number;
}): boolean {
  if (!params.fromUserId) return false;
  if (params.messageType !== undefined && params.messageType !== 1) return false;
  if (params.fromUserId.includes("@chatroom")) return false;
  return params.fromUserId === params.boundUserId;
}
