// AIC-69 — code.delegate: hand off a coding task to any ACP-conformant
// coding agent (Goose, Codex, Claude Code, …) via stdio JSON-RPC. The tick
// loop still owns the "when" and "why"; the delegated agent owns the "how".
//
// Config via env:
//   ACP_AGENT_CMD           — required. Command line for the ACP agent
//                             binary, space-separated. e.g. "goose acp"
//                             or "claude-code --acp".
//   ACP_ALLOW_KINDS         — comma-separated permission kinds to
//                             auto-approve. Default "read,edit". Include
//                             "execute" only if you trust this task to run
//                             commands.
//   ACP_TIMEOUT_MS          — max wall time per delegate call. Default 5min.
//
// See docs/adr/0002-acp-code-delegate.md for the design rationale.

import type { ToolDef, ToolCtx } from "../runtime/tools.ts";
import { runAcpTurn, type PermissionKind } from "../adapters/acp.ts";
import { join, isAbsolute, resolve } from "node:path";

const ALL_KINDS: PermissionKind[] = ["read", "edit", "delete", "execute", "search", "fetch", "think", "move", "other"];

function parseAllowKinds(csv: string | undefined): PermissionKind[] {
  if (!csv) return ["read", "edit"];
  const set = new Set(csv.split(",").map((s) => s.trim().toLowerCase()));
  return ALL_KINDS.filter((k) => set.has(k));
}

export const codeDelegate: ToolDef = {
  name: "code.delegate",
  kind: "action",
  description:
    "Delegate a well-scoped coding task to an ACP-conformant coding agent (Goose / Codex / Claude Code / etc.). Use for changes you cannot make with a single tool call: multi-file edits, refactors, feature scaffolds, bug fixes with tests. Provide a clear, self-contained brief — the delegated agent has no memory of prior ticks. Returns the transcript, tool-call summary, and stop reason. This action can run for several minutes; only invoke when the task is genuinely worth a delegate turn.",
  inputSchema: {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: {
        type: "string",
        description: "Self-contained brief for the delegated agent. Include: what to change, where, and how you'll know it worked. Do NOT assume the agent shares your context.",
      },
      cwd: {
        type: "string",
        description: "Sandbox root for the delegated agent. Defaults to the coworker's own state/scratch directory. Any absolute path escaping this root is rejected.",
      },
      allowKinds: {
        type: "array",
        items: { type: "string", enum: ALL_KINDS },
        description: "Override the default permission set (read+edit). Include 'execute' only if the task legitimately needs to run commands.",
      },
    },
  },
  handler: async (
    input: { prompt: string; cwd?: string; allowKinds?: PermissionKind[] },
    ctx: ToolCtx,
  ) => {
    if (ctx.dryRun) return { dryRun: true, wouldPrompt: input.prompt.slice(0, 200) };

    const cmdSpec = ctx.env.ACP_AGENT_CMD?.trim();
    if (!cmdSpec) return { error: "ACP_AGENT_CMD not set — cannot delegate to a coding agent" };

    // Default cwd: coworker's own scratch dir (created if missing). Absolute
    // path lands next to state/ so the delegated agent's writes are visible
    // to the operator via the same tail-based tools.
    const repoRoot = new URL("../..", import.meta.url).pathname;
    const defaultCwd = join(repoRoot, "coworkers", ctx.coworker, "state", "scratch");
    let cwd = input.cwd ?? defaultCwd;
    if (!isAbsolute(cwd)) cwd = resolve(repoRoot, cwd);

    const allowKinds = input.allowKinds ?? parseAllowKinds(ctx.env.ACP_ALLOW_KINDS);
    const timeoutMs = Number(ctx.env.ACP_TIMEOUT_MS ?? 5 * 60_000);
    const agentCmd = cmdSpec.split(/\s+/).filter(Boolean);

    const result = await runAcpTurn({ agentCmd, prompt: input.prompt, cwd, allowKinds, timeoutMs });

    return {
      stopReason: result.stopReason,
      transcript: result.transcript,
      toolCalls: result.toolCalls,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.plan ? { plan: result.plan } : {}),
      ...(result.error ? { error: result.error } : {}),
      cwd,
    };
  },
};

export const codeDelegateTools: ToolDef[] = [codeDelegate];
