// AIC-73 — subprocess sandboxing. Ship a real, opt-in defence-in-depth for
// the highest-risk thing the runtime spawns today: the delegated coding
// agent (see src/adapters/acp.ts). Broader container-per-ToolDef isolation
// is designed in docs/adr/0003-container-isolation.md but not implemented
// here — that requires an operator-installed container runtime and enough
// infra plumbing to be its own project.
//
// This module gives you `wrapWithSandbox(argv, opts)` that either returns
// the original argv (no sandbox available or disabled) or an argv that
// runs the same command inside a bwrap / firejail jail scoped to the
// caller's cwd. Callers use it as `const [cmd, ...args] = wrapWithSandbox(...)`.
//
// Env-driven config:
//   AICW_SANDBOX = "auto" | "off" | "bwrap" | "firejail"
//     auto (default): use bwrap if available, else firejail, else nothing.
//     off:            never sandbox.
//     bwrap|firejail: require that specific tool; fall back to direct + a
//                     WARNING log entry so operators notice.
//
// Non-Linux platforms fall back to no-sandbox with a warning.

import { execSync } from "node:child_process";
import { resolve } from "node:path";

export type SandboxKind = "auto" | "off" | "bwrap" | "firejail";

export interface SandboxOpts {
  cwd: string;                   // absolute; write-bound into the jail
  readOnlyPaths?: string[];      // additional read-only mounts (e.g. system dirs the agent needs)
  allowNetwork?: boolean;        // default true — LLM APIs and git servers need net
  kind?: SandboxKind;            // override env-based default
}

export interface SandboxResult {
  argv: string[];                // command + args (possibly wrapped)
  sandbox: "bwrap" | "firejail" | "none";
  reason?: string;               // when sandbox is 'none', why
}

// Cache which/lookup results — sandbox tools don't get installed mid-run.
const availability = new Map<string, boolean>();

function have(cmd: string): boolean {
  const cached = availability.get(cmd);
  if (cached !== undefined) return cached;
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    availability.set(cmd, true);
    return true;
  } catch {
    availability.set(cmd, false);
    return false;
  }
}

// Test helper — reset the cache between test cases.
export function _resetSandboxCacheForTests(): void {
  availability.clear();
}

export function wrapWithSandbox(argv: string[], opts: SandboxOpts): SandboxResult {
  const kind = opts.kind ?? (process.env.AICW_SANDBOX as SandboxKind | undefined) ?? "auto";
  if (kind === "off") return { argv, sandbox: "none", reason: "AICW_SANDBOX=off" };
  if (process.platform !== "linux") {
    return { argv, sandbox: "none", reason: `sandboxing unsupported on ${process.platform}` };
  }
  if (argv.length === 0) return { argv, sandbox: "none", reason: "empty argv" };

  const wantBwrap    = kind === "bwrap"    || (kind === "auto" && have("bwrap"));
  const wantFirejail = kind === "firejail" || (kind === "auto" && !wantBwrap && have("firejail"));

  if (wantBwrap && have("bwrap")) return { argv: bwrapWrap(argv, opts), sandbox: "bwrap" };
  if (wantFirejail && have("firejail")) return { argv: firejailWrap(argv, opts), sandbox: "firejail" };

  if (kind === "bwrap")    return { argv, sandbox: "none", reason: "bwrap requested but not installed" };
  if (kind === "firejail") return { argv, sandbox: "none", reason: "firejail requested but not installed" };
  return { argv, sandbox: "none", reason: "no sandbox tool available (install bwrap or firejail)" };
}

function bwrapWrap(argv: string[], opts: SandboxOpts): string[] {
  const cwd = resolve(opts.cwd);
  const wrapped: string[] = [
    "bwrap",
    // Read-only bind of the host root so the agent can find its binaries.
    "--ro-bind", "/", "/",
    // Writable dev + tmp (agents often need /tmp for scratch files).
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    // The one writable path is the caller's cwd — the agent may edit files here.
    "--bind", cwd, cwd,
    "--chdir", cwd,
    "--die-with-parent",
    // No new privileges — even if the sandboxed binary is setuid, it can't escalate.
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    ...(opts.allowNetwork === false ? ["--unshare-net"] : []),
    ...((opts.readOnlyPaths ?? []).flatMap((p) => ["--ro-bind", resolve(p), resolve(p)])),
    "--",
    ...argv,
  ];
  return wrapped;
}

function firejailWrap(argv: string[], opts: SandboxOpts): string[] {
  const cwd = resolve(opts.cwd);
  // firejail is more magical than bwrap; we ask for a minimal profile and
  // whitelist the cwd. `--noprofile` disables the auto-loaded profile so we
  // aren't surprised by distro-shipped defaults.
  return [
    "firejail",
    "--quiet",
    "--noprofile",
    "--private-tmp",
    `--whitelist=${cwd}`,
    ...(opts.allowNetwork === false ? ["--net=none"] : []),
    "--",
    ...argv,
  ];
}
