// MCP bridge — connect to a Model Context Protocol server (either as a
// stdio subprocess or over Streamable HTTP), list its tools, register each
// as a ToolDef in our registry. This is the biggest single ecosystem
// unlock: Linear, Slack, GitHub, Notion, Gmail, filesystem, browser
// automation, etc. all ship official MCP servers.
//
// A single .env variable declares the servers to load:
//   MCP_SERVERS='[{"name":"github","command":"npx","args":["@modelcontextprotocol/server-github"]}]'
//   MCP_SERVERS='[{"name":"remote","url":"https://mcp.example.com/mcp","bearerEnv":"EXAMPLE_TOKEN"}]'
//
// Or via a config file at coworkers/<name>/mcp.json (per-coworker scoping).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDef, ToolCtx } from "../runtime/tools.ts";
import type { DatabaseSync } from "node:sqlite";
import { register, markStatus } from "../runtime/hygiene.ts";
import { createOAuthProvider, type McpOAuthClientProvider } from "./mcp_oauth.ts";

export interface McpServerConfig {
  name: string;                              // prefix for the registered tools, e.g. "github"
  // stdio transport — subprocess to spawn:
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http transport — streamable HTTP endpoint:
  url?: string;
  headers?: Record<string, string>;          // static request headers (e.g. "Authorization")
  bearerEnv?: string;                        // env var whose value becomes "Authorization: Bearer <value>"
  oauth?: {
    scopes?: string[];                       // requested scopes; defaults to whatever server metadata says
    redirectPort?: number;                   // loopback listener port; 0/omitted = free port
    callbackHost?: string;                   // default "127.0.0.1"
  };
}

export interface McpConnection {
  client: Client;
  tools: ToolDef[];
  close(): Promise<void>;
}

// Validate that exactly one of {command, url} is set. Throws a clear error.
export function validateMcpConfig(cfg: McpServerConfig): "stdio" | "http" {
  const hasCommand = typeof cfg.command === "string" && cfg.command.length > 0;
  const hasUrl = typeof cfg.url === "string" && cfg.url.length > 0;
  if (hasCommand && hasUrl) {
    throw new Error(
      `MCP server "${cfg.name}": both "command" and "url" set — provide exactly one.`,
    );
  }
  if (!hasCommand && !hasUrl) {
    throw new Error(
      `MCP server "${cfg.name}": neither "command" nor "url" set — provide exactly one.`,
    );
  }
  if (cfg.oauth) {
    if (!hasUrl) {
      throw new Error(
        `MCP server "${cfg.name}": "oauth" requires "url" (stdio transport does not support OAuth).`,
      );
    }
    if (cfg.bearerEnv) {
      throw new Error(
        `MCP server "${cfg.name}": "oauth" and "bearerEnv" are mutually exclusive — pick one.`,
      );
    }
  }
  return hasCommand ? "stdio" : "http";
}

// Build the header map for an HTTP MCP transport. Resolves bearerEnv against
// the given process env; throws a clear error naming the missing var if the
// env var is unset. Pure — no I/O.
export function buildHttpHeaders(
  cfg: McpServerConfig,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
  if (cfg.bearerEnv) {
    const val = env[cfg.bearerEnv];
    if (!val) {
      throw new Error(
        `MCP server "${cfg.name}": bearerEnv "${cfg.bearerEnv}" is not set in the process env.`,
      );
    }
    headers["Authorization"] = `Bearer ${val}`;
  }
  return headers;
}

export async function connectMcp(
  cfg: McpServerConfig,
  hygieneDb?: DatabaseSync,
  coworkerStateDir?: string,
  coworkerName?: string,
): Promise<McpConnection> {
  const kind = validateMcpConfig(cfg);

  let transport: Transport;
  let hygieneKind: "subprocess" | "http_client";
  let hygieneHandle: string;
  let oauthProvider: McpOAuthClientProvider | null = null;

  if (kind === "http") {
    if (cfg.oauth) {
      if (!coworkerStateDir) {
        throw new Error(
          `MCP server "${cfg.name}": oauth requires coworkerStateDir to persist tokens.`,
        );
      }
      oauthProvider = createOAuthProvider({
        serverName: cfg.name,
        coworkerName: coworkerName ?? "coworker",
        coworkerStateDir,
        scopes: cfg.oauth.scopes,
        redirectPort: cfg.oauth.redirectPort,
        callbackHost: cfg.oauth.callbackHost,
      });
      transport = new StreamableHTTPClientTransport(new URL(cfg.url!), {
        authProvider: oauthProvider,
      });
    } else {
      const headers = buildHttpHeaders(cfg, process.env);
      transport = new StreamableHTTPClientTransport(new URL(cfg.url!), {
        requestInit: { headers },
      });
    }
    hygieneKind = "http_client";
    hygieneHandle = `mcp:${cfg.name}:${cfg.url}`;
  } else {
    transport = new StdioClientTransport({
      command: cfg.command!,
      args: cfg.args ?? [],
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
    });
    hygieneKind = "subprocess";
    hygieneHandle = `mcp:${cfg.name}`;
  }

  const client = new Client(
    { name: `ai-coworkers/${cfg.name}`, version: "0.1.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
  } catch (err) {
    if (err instanceof UnauthorizedError && oauthProvider) {
      // SDK's auth flow needs a browser round-trip. Wait for the loopback
      // listener to receive the authorization code, then exchange it and
      // reconnect. On success the provider persists tokens; a future
      // restart will find them cached and skip the browser flow entirely.
      const code = await oauthProvider.waitForAuthorizationCode();
      await (transport as StreamableHTTPClientTransport).finishAuth(code);
      await oauthProvider.shutdownListener();
      await client.connect(transport);
    } else {
      if (oauthProvider) await oauthProvider.shutdownListener();
      throw err;
    }
  }
  // AIC-44 — register the transport in the hygiene ledger so we don't
  // accumulate orphan MCP connections across restarts. For stdio the SDK
  // doesn't expose the child pid; we register the server name as a stable
  // handle. For http there's no subprocess — we register kind="http_client"
  // with the URL as the handle so hygieneSweep can still audit "how many
  // MCP connections are believed alive".
  let hygieneId: number | null = null;
  if (hygieneDb) {
    hygieneId = register(hygieneDb, hygieneKind, hygieneHandle, null);
  }
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
    close: async () => {
      try { await client.close(); } catch {}
      if (hygieneDb && hygieneId != null) markStatus(hygieneDb, hygieneId, "completed");
    },
  };
}

// Parse MCP_SERVERS env var into typed configs. Returns [] on unset or malformed.
// Accepts either stdio ({name, command, ...}) or http ({name, url, ...}) entries.
export function parseMcpEnv(env: NodeJS.ProcessEnv): McpServerConfig[] {
  const raw = env.MCP_SERVERS;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((s): s is McpServerConfig =>
      typeof s?.name === "string" &&
      (typeof s?.command === "string" || typeof s?.url === "string"));
  } catch {
    return [];
  }
}
