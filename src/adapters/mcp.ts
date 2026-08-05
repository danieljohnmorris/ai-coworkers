// MCP bridge — spawn a Model Context Protocol server as a subprocess, list
// its tools, register each as a ToolDef in our registry. This is the biggest
// single ecosystem unlock: Linear, Slack, GitHub, Notion, Gmail, filesystem,
// browser automation, etc. all ship official MCP servers.
//
// A single .env variable declares the servers to load:
//   MCP_SERVERS='[{"name":"github","command":"npx","args":["@modelcontextprotocol/server-github"]}]'
//
// Or via a config file at coworkers/<name>/mcp.json (per-coworker scoping).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDef, ToolCtx } from "../runtime/tools.ts";

export interface McpServerConfig {
  name: string;                              // prefix for the registered tools, e.g. "github"
  command: string;                           // executable
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConnection {
  client: Client;
  tools: ToolDef[];
  close(): Promise<void>;
}

export async function connectMcp(cfg: McpServerConfig): Promise<McpConnection> {
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
  });
  const client = new Client(
    { name: `ai-coworkers/${cfg.name}`, version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const listed = await client.listTools();
  const tools: ToolDef[] = listed.tools.map((t) => ({
    name: `mcp.${cfg.name}.${t.name}`,
    // MCP doesn't distinguish read vs write; default to "action" and let
    // AUTHORITY.md gate anything that matters.
    kind: "action" as const,
    description: t.description ?? `MCP tool ${t.name} on server ${cfg.name}`,
    inputSchema: (t.inputSchema as object) ?? { type: "object" },
    handler: async (input: unknown, ctx: ToolCtx) => {
      if (ctx.dryRun) return { dryRun: true, would: { server: cfg.name, tool: t.name, input } };
      const result = await client.callTool({ name: t.name, arguments: (input as Record<string, unknown>) ?? {} });
      return result;
    },
  }));
  return {
    client,
    tools,
    close: async () => { try { await client.close(); } catch {} },
  };
}

// Parse MCP_SERVERS env var into typed configs. Returns [] on unset or malformed.
export function parseMcpEnv(env: NodeJS.ProcessEnv): McpServerConfig[] {
  const raw = env.MCP_SERVERS;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((s): s is McpServerConfig =>
      typeof s?.name === "string" && typeof s?.command === "string");
  } catch {
    return [];
  }
}
