import type { AgentService } from "../../core/AgentService.js";
import type { AccountData } from "../../config/accounts.js";
import type { BridgeSession } from "../../session/types.js";
import type { SessionStorePort } from "../../core/types.js";
import type { ToolResult } from "../../core/errors.js";

export interface BridgeMcpContext {
  account: AccountData | null;
  session: BridgeSession | null;
  sessionStore: SessionStorePort | null;
  agentService: AgentService;
  extraWritableRoots?: string[];
}

export interface BridgeToolDefinition {
  name: string;
  description: string;
}

export type BridgeToolHandler = (context: BridgeMcpContext, input: Record<string, unknown>) => Promise<ToolResult>;

export interface BridgeTool extends BridgeToolDefinition {
  handler: BridgeToolHandler;
}

export function requireBoundSession(context: BridgeMcpContext): {
  account: AccountData;
  session: BridgeSession;
  sessionStore: SessionStorePort;
} {
  if (!context.account) {
    throw new Error("WeChat account is not bound. Run npm run setup first.");
  }
  if (!context.session || !context.sessionStore) {
    throw new Error("Bridge session is not available.");
  }
  return { account: context.account, session: context.session, sessionStore: context.sessionStore };
}

export function stringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value.trim() : undefined;
}

export function numberInput(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
