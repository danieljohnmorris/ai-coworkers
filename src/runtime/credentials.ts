// AIC-74 — credential broker. Historically every tool handler received
// the whole `process.env`, so a rogue prompt or a delegated ACP agent that
// reached a shell-shaped tool could dump every API key in the coworker's
// environment. That's a bigger blast radius than the runtime's boundary
// regex can catch, because leaking a token is a write-shaped action that
// the boundary layer never sees.
//
// The fix: tools declare which credentials they need (`requiresCreds`);
// the registry passes a *filtered* env that contains only those, plus
// every non-credential variable (which stays visible because tools
// legitimately read PATH, HOME, etc.).
//
// This module owns:
//   - a heuristic for "is this env var a credential?"  (used to decide
//     what gets stripped from a tool's env by default)
//   - filterEnvForTool(env, allowed): the actual filter
//   - default allow-lists for tools that predate `requiresCreds` (empty
//     — such tools get the historical full env; migration is opt-in).

// Env-var patterns treated as credentials. Kept liberal on purpose — new
// tokens with novel names still get caught. False positives (a variable
// matching the pattern that isn't really secret) only harm tools that
// legitimately need to read it, and those tools should declare it via
// requiresCreds anyway.
const CREDENTIAL_PATTERNS: RegExp[] = [
  /_TOKEN$/i,
  /_API_KEY$/i,
  /_APIKEY$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /_PASSWD$/i,
  /_PRIVATE_KEY$/i,
  /^(GH|GITHUB)_PAT$/i,
  /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$/,
  /^ANTHROPIC_API_KEY$/,
  /^OPENAI_API_KEY$/,
  /^OLLAMA_API_KEY$/,
];

export function isCredentialName(name: string): boolean {
  return CREDENTIAL_PATTERNS.some((re) => re.test(name));
}

// Return the subset of env vars a tool is allowed to see: every non-secret
// variable, plus only the credentials it declared it needs.
export function filterEnvForTool(env: NodeJS.ProcessEnv, allowed: readonly string[] | undefined): NodeJS.ProcessEnv {
  // undefined `allowed` means the tool hasn't been migrated to declare
  // credentials — preserve historical behaviour (full env). This keeps the
  // change backwards-compatible; migration is opt-in.
  if (allowed === undefined) return env;

  const allowSet = new Set(allowed);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!isCredentialName(k) || allowSet.has(k)) out[k] = v;
  }
  return out;
}
