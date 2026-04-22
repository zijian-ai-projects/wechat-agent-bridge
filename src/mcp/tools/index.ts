export type { BridgeMcpContext } from "./types.js";

import { fail, type ToolResult } from "../../core/errors.js";
import { agentInterruptTool } from "./agentInterrupt.js";
import { agentResumeTool } from "./agentResume.js";
import { agentSetCwdTool } from "./agentSetCwd.js";
import { agentSetModeTool } from "./agentSetMode.js";
import { sessionClearTool } from "./sessionClear.js";
import { wechatBindStatusTool } from "./wechatBind.js";
import { wechatHistoryTool } from "./wechatHistory.js";
import { wechatStatusTool } from "./wechatStatus.js";
import type { BridgeMcpContext, BridgeTool, BridgeToolDefinition } from "./types.js";

const TOOLS: BridgeTool[] = [
  wechatStatusTool,
  wechatBindStatusTool,
  wechatHistoryTool,
  sessionClearTool,
  agentResumeTool,
  agentInterruptTool,
  agentSetModeTool,
  agentSetCwdTool,
];

export function listBridgeTools(): BridgeToolDefinition[] {
  return TOOLS.map(({ name, description }) => ({ name, description }));
}

export async function callBridgeTool(context: BridgeMcpContext, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return fail(new Error(`Unknown MCP tool: ${name}`), "UNKNOWN_TOOL");
  try {
    return await tool.handler(context, input);
  } catch (error) {
    return fail(error);
  }
}

export function getBridgeTools(): BridgeTool[] {
  return [...TOOLS];
}
