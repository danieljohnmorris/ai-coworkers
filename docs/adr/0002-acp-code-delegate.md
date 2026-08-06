# ADR 0002 — code.delegate speaks Agent Client Protocol (ACP)

**Status:** Accepted (2026-08-06)
**Ticket:** [AIC-69](https://linear.app/ilo-lang/issue/AIC-69)

## Context

An ai-coworker needs a way to delegate coding work — multi-file edits,
refactors, feature scaffolds — that exceeds what a single tool call can do.
The tick loop is the wrong altitude for actual code changes: it owns the
_when_ and _why_, not the _how_.

Rather than write our own coding-agent harness, we adopt an existing
protocol so any conformant coding agent can plug in.

## Options considered

1. **Custom JSON tool interface.** Fastest to build; locks us to whatever
   backend we choose first; every other backend needs a bespoke shim.
2. **Model Context Protocol (MCP).** We already have an MCP adapter. But
   MCP is designed for tool-servers, not coding agents that stream plans,
   tool-calls, file diffs, and turn-level stop reasons. Wrong shape.
3. **Agent Client Protocol (ACP)** — Zed's open protocol
   (agentclientprotocol.com), JSON-RPC over stdio. Already supported by
   Goose, Codex, Claude Code, and the ecosystem Block chose for `buzz-cli`.
   Same shape ai-coworkers wants: prompt-turn semantics, file-system
   requests, permission prompts, tool-call updates.

**Chosen:** ACP. One well-defined protocol, multiple backends work
unmodified, momentum behind the spec.

## Decision

Implement an ACP _client_ (`src/adapters/acp.ts`) that spawns any ACP
agent binary as a subprocess and drives a single prompt turn end-to-end.
Wrap it in a `code.delegate` tool (`src/tools/code_delegate.ts`) that the
coworker can call from its normal deliberation loop.

### v1 scope (deliberate)

- **stdio transport only.** The spec's HTTP/WS transports are still WIP.
- **One-shot sessions.** Each `code.delegate` call spawns a fresh
  subprocess: `initialize` → `session/new` → `session/prompt` → collect
  updates → stopReason → exit. No `session/load`, no reuse.
- **fs/read_text_file and fs/write_text_file honoured**, but every path is
  checked against the tool's `cwd`. Any attempt to read or write outside
  the sandbox root fails with an error to the agent, not a silent success.
- **Permission model:** `session/request_permission` is auto-answered based
  on the tool call's `kind`. Defaults allow `read` + `edit`; `execute` +
  `delete` are auto-rejected unless the caller explicitly opts in via the
  tool's `allowKinds` input or the `ACP_ALLOW_KINDS` env var.
- **terminal/\*** not implemented — returns MethodNotFound. Adding it later
  is straightforward but the security surface (arbitrary command execution
  inside a coworker's process) is non-trivial and deserves its own ADR.
- **MCP-over-ACP** not implemented. Coworkers already expose MCP via
  `MCP_SERVERS`; passing MCP servers through a delegated agent would let
  it call our tools indirectly, defeating the point of BOUNDARIES.md.

### Configuration

Set at least `ACP_AGENT_CMD` in the coworker's env (or globally):

```
ACP_AGENT_CMD="goose acp"          # or "claude-code --acp" or "codex acp"
ACP_ALLOW_KINDS="read,edit"        # default; add "execute" carefully
ACP_TIMEOUT_MS=300000              # default 5 min per delegate call
```

The tool's default `cwd` is
`coworkers/<name>/state/scratch/`, so delegated writes are visible via the
same `tail -f state/highlights.log` workflow operators already use.

## Consequences

**+** Any current or future ACP agent works with zero code changes on our
side. Block, Zed, Anthropic, and the Codex team maintain the backends; we
maintain a ~350-line client.

**+** The permission model gives a coworker granular control per delegate
call — a triage coworker can allow reads for context but reject edits;
a PR-reviewer can allow both but reject execute.

**+** Because each call is one-shot, a hung agent doesn't poison the
coworker's tick loop — the timeout kills the subprocess and we move on.

**−** No streaming to the operator during a turn. Updates are collected and
returned at end-of-turn. A future revision can pipe `agent_message_chunk`
notifications into `log.stream()` for live tailing, at the cost of
interleaving with normal tick output.

**−** Delegated agents can't call our normal ai-coworkers tools (Linear,
Slack, etc.). By design — mixing scopes would blur the "coworker vs.
delegated worker" boundary that keeps BOUNDARIES.md meaningful.

**−** Because we spawn a fresh process per call, cold start dominates for
small tasks. Long-lived sessions (`session/load`) are a v2 concern.

## Reference

- Spec: <https://agentclientprotocol.com/protocol/v1/>
- Prior art: Block's `buzz-cli` uses the same ACP client pattern (see
  `github.com/block/buzz`).
