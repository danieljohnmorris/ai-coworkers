# ADR 0003 — subprocess sandboxing, container isolation

**Status:** Partially accepted (2026-08-06). Sandboxing for the ACP
delegated agent lands now; per-tool container isolation is designed here
but not implemented — deferred until an operator asks for it and the
security review is done.
**Ticket:** [AIC-73](https://linear.app/ilo-lang/issue/AIC-73)

## Context

`--live` mode gates writes with `BOUNDARIES.md` regex + dry-run. That's
a *policy* layer, not a *runtime* one: a tool handler that spawns
`bash -c "$user_input"` (nobody's writing that today, but a future
delegated agent might) would bypass every boundary check because the
boundary matcher sees the tool call as `{tool: "shell", input: {...}}`,
not the individual subprocess actions.

The two credible attack scenarios:

1. **Malicious tool input** — a prompt-injection payload steers a
   coworker into calling a shell-shaped tool with harmful arguments.
   Boundaries catch obvious cases (`rm -rf /`, secret paths) but not
   novel ones.

2. **Compromised delegated agent** — via `code.delegate` we spawn arbitrary
   ACP-conformant binaries (Goose, Codex, Claude Code). Any of those could
   be swapped for a malicious build; we should not trust the subprocess
   with the full host filesystem.

## Decision

Two tiers, one shipping now, one designed for later.

### Tier 1 — spawned-subprocess sandboxing (SHIPPING)

`src/runtime/sandbox.ts::wrapWithSandbox(argv, opts)` wraps any argv in
a Linux user-namespace jail via **bwrap** (preferred) or **firejail**
(fallback). The wrapped process:

- Sees the host root as read-only.
- Can only write inside the caller-declared `cwd`.
- Runs in fresh user / pid / ipc / uts namespaces (no privilege escalation
  even if the binary is setuid).
- Keeps network by default (LLM APIs, git servers, ACP RPC) — `allowNetwork:
  false` unshares network too.

Config via `AICW_SANDBOX = auto | off | bwrap | firejail` (default `auto`).

Wired into `src/adapters/acp.ts` so every `code.delegate` call jails the
delegated agent. If bwrap/firejail isn't installed, the launch still
succeeds with a `sandbox: "none"` reason — production operators should
set `AICW_SANDBOX=bwrap` to make sandbox absence a hard failure. (This
is not the default so local development on non-Linux still works.)

### Tier 2 — per-tool container isolation (DESIGNED, NOT SHIPPED)

The end-state target is a `ToolDef.runInContainer: true | ContainerConfig`
flag. When set, the runtime runs the handler inside a short-lived
container with only declared mounts and env. Concretely:

```ts
export const shellExec: ToolDef = {
  name: "shell.exec",
  runInContainer: {
    image: "alpine:3.20",
    mounts: [{ path: "$WORKSPACE", mode: "rw" }],
    network: "restricted",
  },
  handler: async (input, ctx) => { /* ... */ },
};
```

Why this is deferred:

- **Runtime dependency** — docker or podman must exist on the host and
  the coworker process must have permission to spawn them. Adding a
  hard runtime dep to a Node-only project is a real philosophy shift.
- **Coldstart cost** — spinning a container per tool call is 200-500ms
  overhead. Fine for `shell.exec`; painful for `linear.comment`.
- **API surface** — every ToolDef gets a new optional field, and the
  registry loses its "call handler(input, ctx) and get a result"
  simplicity because handlers can't run in-process.
- **Security review** — proper container escape mitigation, mount policy
  language, resource limits, cleanup — this is its own project.

Tier 1 (subprocess sandboxing) covers ~90% of the real risk because
that's where arbitrary code execution lives. In-process tool handlers
(linear/slack/github/memory) don't need Tier 2 — they don't shell out,
their input is validated JSON, and the boundary layer already covers the
outputs.

## Consequences

**+** Sandboxing for ACP delegated agents in <100 lines. No new runtime
dependency (bwrap ships in most distros; falls back cleanly if missing).

**+** The interface (`wrapWithSandbox`) is easily wired into any future
subprocess-spawning tool. When `bin/import-hermes.sh`-style scripts start
to run themselves against untrusted inputs, the same wrapper protects them.

**+** Non-Linux dev environments (mac/windows) keep working — sandbox
degrades to no-op with a clear reason, and the operator sees it in logs.

**−** bwrap semantics vary slightly across distros (some restrict user
namespaces). We rely on the host's kernel config; a locked-down environment
that disables user namespaces will silently degrade to `sandbox: "none"`.
Documented; operators who care set `AICW_SANDBOX=bwrap` to fail loud.

**−** Tier 2 (per-tool containers) is deferred. If a native tool handler
gets compromised via prompt injection today, the boundary layer is our
only defence.

## Reference

- bwrap: <https://github.com/containers/bubblewrap>
- firejail: <https://firejail.wordpress.com/>
- Related: [ADR 0002 — code.delegate speaks ACP](./0002-acp-code-delegate.md)
