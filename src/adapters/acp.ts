// AIC-69 — Agent Client Protocol client. Talks JSON-RPC-over-stdio to any
// ACP-conformant coding agent (Goose, Codex, Claude Code, etc.), so a
// coworker can delegate a well-scoped coding task without us re-inventing
// the harness. Adopts Zed's ACP so any future ACP agent Just Works.
//
// v1 scope (deliberate):
//   - stdio transport only (spec's HTTP/WS transports are still WIP)
//   - one-shot: spawn → initialize → session/new → session/prompt → stopReason → exit
//   - no session/load (each delegate call is fresh)
//   - permission model: read/edit auto-allowed, execute/delete auto-rejected
//     unless caller opts in via `allowKinds`. Never auto-approves `execute`
//     without an explicit "yes, this delegate task may run commands".
//   - fs/read_text_file and fs/write_text_file honoured, but every path is
//     checked against `cwd`: no reads or writes outside the sandbox root.
//   - terminal/* not supported yet — returns MethodNotFound to the agent.
//
// Spec: https://agentclientprotocol.com/protocol/v1/

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { wrapWithSandbox } from "../runtime/sandbox.ts";

const PROTOCOL_VERSION = 1;

// ---- public types ----

export type PermissionKind = "read" | "edit" | "delete" | "execute" | "search" | "fetch" | "think" | "move" | "other";

export interface TurnRequest {
  agentCmd: string[];              // e.g. ["goose", "acp"] or ["claude-code", "--acp"]
  prompt: string;
  cwd: string;                     // sandbox root — fs reads/writes must stay inside
  allowKinds?: PermissionKind[];   // permission-request kinds we auto-approve. Default: ["read","edit"].
  timeoutMs?: number;              // hard ceiling on the whole turn. Default 5 min.
  env?: Record<string, string>;    // additional env vars for the subprocess
}

export interface ToolCallSummary {
  toolCallId: string;
  title: string;
  kind: PermissionKind;
  status: "pending" | "in_progress" | "completed" | "failed";
  permission?: "allowed" | "rejected" | "not_asked";
}

export interface UsageSummary {
  used?: number;
  size?: number;
  cost?: { amount: number; currency: string };
}

export interface TurnResult {
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "timeout" | "error";
  transcript: string;              // concatenated agent_message_chunk text
  toolCalls: ToolCallSummary[];
  usage?: UsageSummary;
  plan?: { content: string; status: string; priority?: string }[];
  error?: string;
}

// ---- JSON-RPC framing ----
// ACP uses LSP-style Content-Length framed messages on stdio.

interface RpcRequest { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown; }
interface RpcResponse { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: { code: number; message: string; data?: unknown }; }
interface RpcNotification { jsonrpc: "2.0"; method: string; params?: unknown; }
type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

function encodeFrame(msg: unknown): string {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

// Streaming frame parser — pulls complete messages out of a growing buffer.
class FrameParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer, onMessage: (m: RpcMessage) => void): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buf.slice(0, headerEnd).toString("utf8");
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        // Malformed — drop bytes up to the delimiter and keep going.
        this.buf = this.buf.slice(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return; // more bytes needed
      const body = this.buf.slice(start, start + len).toString("utf8");
      this.buf = this.buf.slice(start + len);
      try { onMessage(JSON.parse(body) as RpcMessage); } catch { /* skip bad frame */ }
    }
  }
}

// ---- main entrypoint ----

export async function runAcpTurn(req: TurnRequest): Promise<TurnResult> {
  const allowKinds = new Set<PermissionKind>(req.allowKinds ?? ["read", "edit"]);
  const timeoutMs = req.timeoutMs ?? 5 * 60_000;
  const cwd = resolve(req.cwd);

  if (req.agentCmd.length === 0) return { stopReason: "error", transcript: "", toolCalls: [], error: "agentCmd is empty" };

  // AIC-73 — optionally wrap the agent subprocess in a bwrap/firejail
  // sandbox. Filesystem writes are jailed to `cwd`; the rest of the host
  // is read-only. See src/runtime/sandbox.ts for env-var config.
  const sandboxed = wrapWithSandbox(req.agentCmd, { cwd });
  const [cmd, ...args] = sandboxed.argv;
  if (!cmd) return { stopReason: "error", transcript: "", toolCalls: [], error: "sandbox wrap produced empty argv" };

  const child: ChildProcess = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...req.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const parser = new FrameParser();
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const toolCalls = new Map<string, ToolCallSummary>();
  let transcript = "";
  let usage: UsageSummary | undefined;
  let plan: TurnResult["plan"];
  let nextId = 1;

  const send = (msg: RpcRequest | RpcResponse | RpcNotification): void => {
    if (child.stdin && !child.stdin.destroyed) child.stdin.write(encodeFrame(msg));
  };

  const request = <T>(method: string, params: unknown): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolveP, rejectP) => {
      pending.set(id, { resolve: (v) => resolveP(v as T), reject: rejectP });
      send({ jsonrpc: "2.0", id, method, params });
    });
  };

  // ---- incoming message dispatch ----

  const handleIncoming = async (m: RpcMessage): Promise<void> => {
    // Response to something we sent.
    if ("id" in m && ("result" in m || "error" in m) && !("method" in m)) {
      const p = pending.get(m.id as number);
      if (!p) return;
      pending.delete(m.id as number);
      if ("error" in m && m.error) p.reject(new Error(`${m.error.code}: ${m.error.message}`));
      else p.resolve((m as RpcResponse).result);
      return;
    }

    // Request from the agent — we must respond.
    if ("id" in m && "method" in m) {
      const req = m as RpcRequest;
      try {
        const result = await handleAgentRequest(req.method, req.params, { cwd, allowKinds, toolCalls });
        send({ jsonrpc: "2.0", id: req.id, result });
      } catch (err) {
        send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: String(err) } });
      }
      return;
    }

    // Notification (session/update, etc.)
    if ("method" in m && !("id" in m)) {
      const n = m as RpcNotification;
      if (n.method === "session/update") {
        applySessionUpdate(n.params, { toolCalls, appendText: (t) => { transcript += t; }, setUsage: (u) => { usage = u; }, setPlan: (p) => { plan = p; } });
      }
      return;
    }
  };

  const stderrChunks: Buffer[] = [];
  child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
  child.stdout?.on("data", (c: Buffer) => parser.push(c, (msg) => { void handleIncoming(msg); }));
  // Trap async spawn failures (missing binary, permission denied) so they
  // fail every pending request instead of surfacing as unhandled errors.
  child.on("error", (err) => {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });
  // Also trap the case where the child exits without answering — that
  // includes "binary is missing when the outer command was a sandbox
  // wrapper that spawned successfully but then couldn't exec the target"
  // (AIC-73 sandboxing), and any generic crash during a turn.
  child.on("exit", (code, signal) => {
    if (pending.size === 0) return;
    const stderrStr = Buffer.concat(stderrChunks).toString("utf8").slice(-500);
    const reason = new Error(`agent subprocess exited early (code=${code} signal=${signal}) ${stderrStr ? "— stderr: " + stderrStr : ""}`);
    for (const [, p] of pending) p.reject(reason);
    pending.clear();
  });
  child.stdin?.on("error", () => { /* pipe closes when the child dies; swallow */ });

  const cleanup = (): void => {
    for (const [, p] of pending) p.reject(new Error("connection closed"));
    pending.clear();
    if (!child.killed) { try { child.kill("SIGTERM"); } catch { /* noop */ } }
  };

  // ---- run the turn ----
  try {
    const turn = await withTimeout(async () => {
      // 1. initialize
      await request<{ protocolVersion: number }>("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
        clientInfo: { name: "ai-coworkers", title: "ai-coworkers ACP client", version: "0.1.0" },
      });

      // 2. session/new
      const sess = await request<{ sessionId: string }>("session/new", { cwd, mcpServers: [] });

      // 3. session/prompt (streams session/update along the way; resolves on stopReason)
      const promptResult = await request<{ stopReason: TurnResult["stopReason"] }>("session/prompt", {
        sessionId: sess.sessionId,
        prompt: [{ type: "text", text: req.prompt }],
      });
      return promptResult;
    }, timeoutMs);

    return {
      stopReason: turn.stopReason,
      transcript,
      toolCalls: [...toolCalls.values()],
      ...(usage ? { usage } : {}),
      ...(plan ? { plan } : {}),
    };
  } catch (err) {
    const msg = String(err);
    const stderrStr = Buffer.concat(stderrChunks).toString("utf8").slice(-2000);
    return {
      stopReason: msg.includes("timeout") ? "timeout" : "error",
      transcript,
      toolCalls: [...toolCalls.values()],
      error: stderrStr ? `${msg}\n---stderr---\n${stderrStr}` : msg,
    };
  } finally {
    cleanup();
  }
}

// ---- helpers ----

async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`acp turn timeout after ${ms}ms`)), ms);
  });
  try { return await Promise.race([fn(), timer]); }
  finally { if (t) clearTimeout(t); }
}

async function handleAgentRequest(
  method: string,
  params: unknown,
  ctx: { cwd: string; allowKinds: Set<PermissionKind>; toolCalls: Map<string, ToolCallSummary> },
): Promise<unknown> {
  switch (method) {
    case "session/request_permission": {
      const p = params as { toolCall: { toolCallId: string; kind?: PermissionKind }; options: { optionId: string; kind: string }[] };
      const kind = p.toolCall.kind ?? "other";
      const allow = ctx.allowKinds.has(kind);
      const opt = p.options.find((o) => o.kind === (allow ? "allow_once" : "reject_once"))
        ?? p.options[0];
      const rec = ctx.toolCalls.get(p.toolCall.toolCallId);
      if (rec) rec.permission = allow ? "allowed" : "rejected";
      return { outcome: { type: "selected", optionId: opt.optionId } };
    }

    case "fs/read_text_file": {
      const p = params as { path: string; line?: number; limit?: number };
      const abs = ensureInside(ctx.cwd, p.path);
      const text = await readFile(abs, "utf8");
      // 1-based line/limit slice per spec (both optional).
      const sliced = p.line !== undefined
        ? text.split("\n").slice(p.line - 1, p.limit ? p.line - 1 + p.limit : undefined).join("\n")
        : text;
      return { content: sliced };
    }

    case "fs/write_text_file": {
      const p = params as { path: string; content: string };
      const abs = ensureInside(ctx.cwd, p.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, p.content, "utf8");
      return null;
    }

    default:
      throw new MethodNotFound(method);
  }
}

class MethodNotFound extends Error {
  constructor(method: string) { super(`method not found: ${method}`); }
}

function ensureInside(root: string, p: string): string {
  const target = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const normalizedRoot = resolve(root);
  if (!target.startsWith(normalizedRoot + "/") && target !== normalizedRoot) {
    throw new Error(`path escapes cwd: ${p}`);
  }
  return target;
}

function applySessionUpdate(
  raw: unknown,
  ctx: {
    toolCalls: Map<string, ToolCallSummary>;
    appendText: (t: string) => void;
    setUsage: (u: UsageSummary) => void;
    setPlan: (p: TurnResult["plan"]) => void;
  },
): void {
  const p = raw as { sessionId: string; update: Record<string, unknown> };
  const u = p?.update;
  if (!u || typeof u !== "object") return;
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const content = u.content as { type: string; text?: string } | undefined;
      if (content?.type === "text" && content.text) ctx.appendText(content.text);
      break;
    }
    case "tool_call": {
      const tc = u as { toolCallId: string; title: string; kind?: PermissionKind; status: ToolCallSummary["status"] };
      ctx.toolCalls.set(tc.toolCallId, {
        toolCallId: tc.toolCallId,
        title: tc.title,
        kind: tc.kind ?? "other",
        status: tc.status,
        permission: "not_asked",
      });
      break;
    }
    case "tool_call_update": {
      const tc = u as { toolCallId: string; status?: ToolCallSummary["status"] };
      const existing = ctx.toolCalls.get(tc.toolCallId);
      if (existing && tc.status) existing.status = tc.status;
      break;
    }
    case "usage_update": {
      const usg = u as UsageSummary & { sessionUpdate: string };
      ctx.setUsage({ used: usg.used, size: usg.size, cost: usg.cost });
      break;
    }
    case "plan": {
      const pl = u as { entries?: { content: string; status: string; priority?: string }[] };
      if (pl.entries) ctx.setPlan(pl.entries);
      break;
    }
  }
}
