import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { ToolResult } from "../core/errors.js";
import { callBridgeTool, getBridgeTools, type BridgeMcpContext } from "./tools/index.js";

const INPUT_SCHEMAS = {
  wechat_status: {},
  wechat_bind_status: {},
  wechat_history: { limit: z.union([z.number().int(), z.string()]).optional() },
  session_clear: {},
  agent_resume: { prompt: z.string() },
  agent_interrupt: {},
  agent_set_mode: { mode: z.string() },
  agent_set_cwd: { cwd: z.string() },
} satisfies Record<string, Record<string, z.ZodTypeAny>>;

export function createBridgeMcpServer(context: BridgeMcpContext): McpServer {
  const server = new McpServer({
    name: "wechat-agent-bridge",
    version: "0.1.0",
  });

  for (const tool of getBridgeTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: INPUT_SCHEMAS[tool.name as keyof typeof INPUT_SCHEMAS] ?? {},
      },
      async (input: Record<string, unknown> | undefined) => toolResultToMcp(await callBridgeTool(context, tool.name, input ?? {})),
    );
  }

  return server;
}

export async function runBridgeMcpServer(context: BridgeMcpContext): Promise<void> {
  const server = createBridgeMcpServer(context);
  await server.connect(new StdioServerTransport());
}

function toolResultToMcp(result: ToolResult): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
} {
  const structuredContent = result as unknown as Record<string, unknown>;
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent,
    isError: result.ok ? undefined : true,
  };
}
