// Secret redaction — scans text for credential-shaped substrings and
// replaces them with a `<REDACTED>` marker before persistence or send.
//
// Two layers of matching:
//   1. Pattern library — well-known secret formats we recognise even if
//      the value never passed through our config (Bearer tokens, Linear
//      lin_api_*, Slack xoxb-*, GitHub ghp_*/github_pat_*, Anthropic
//      sk-ant-*, OpenAI sk-*, AWS AKIA*, Google AIza*, PEM private keys).
//   2. Known-values — a caller-provided set of literal strings we're
//      certain are secrets (typically the values of every env var whose
//      name matches isCredentialName()). Catches leakage of a real key
//      via a novel format (e.g. a proprietary API's token that our
//      pattern list has never seen).
//
// Wired into:
//   - Log.stream / Log.highlight / Log.event  (persistence)
//   - ask.handler outbound content              (transport)
//
// The redactor is conservative: it only replaces the MATCHED substring,
// keeping the surrounding context so error messages stay readable
// ("Slack API returned <REDACTED>: 401 unauthorised" is more useful
// debugging than "<REDACTED>").

import { isCredentialName } from "./credentials.ts";

// Ordered longest-first so that a longer/more-specific pattern beats a
// substring of it (e.g. github_pat_ before ghp_).
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "pem_private_key",         re: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g },
  { name: "anthropic_key",           re: /\bsk-ant-[A-Za-z0-9_\-]{40,}\b/g },
  { name: "openai_key",              re: /\bsk-(?:proj-)?[A-Za-z0-9]{40,}\b/g },
  { name: "github_pat_finegrained",  re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { name: "github_pat_classic",      re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { name: "slack_bot_token",         re: /\bxoxb-\d+-\d+-\d+-[a-f0-9]+\b/gi },
  { name: "slack_user_token",        re: /\bxoxp-\d+-\d+-\d+-[a-f0-9]+\b/gi },
  { name: "slack_app_token",         re: /\bxapp-\d+-\d+-\d+-[a-f0-9]+\b/gi },
  { name: "linear_api_key",          re: /\blin_api_[A-Za-z0-9]{20,}\b/g },
  { name: "aws_access_key",          re: /\bAKIA[A-Z0-9]{16}\b/g },
  { name: "google_api_key",          re: /\bAIza[A-Za-z0-9_\-]{35}\b/g },
  { name: "bearer_token",            re: /\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{16,}/gi },
];

const REDACTED = "<REDACTED>";

// Build the set of literal secret values from an env-like object.
// Skips empty values (would eat every empty substring). Callers can pass
// the coworker env produced by loadCoworkerEnv() to catch leakage of the
// specific keys THIS coworker uses.
export function knownSecretsFrom(env: NodeJS.ProcessEnv): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(env)) {
    if (!v || v.length < 8) continue;                // very short values → too risky (false positives)
    if (!isCredentialName(k)) continue;
    out.add(v);
  }
  return out;
}

export interface RedactResult {
  text: string;
  redactionCount: number;
}

export function redact(input: string, knownSecrets?: ReadonlySet<string>): RedactResult {
  if (!input) return { text: input, redactionCount: 0 };
  let text = input;
  let count = 0;

  // 1. Pattern-based redaction. Do it first so a known-secret value that
  // happens to also match a pattern (usually it does) still counts as one
  // redaction, not zero.
  for (const p of SECRET_PATTERNS) {
    text = text.replace(p.re, () => { count++; return `<REDACTED:${p.name}>`; });
  }

  // 2. Known-value replacement. Only run if the caller passed a set (env-
  // driven redaction is opt-in — passing every env value would be over-
  // eager for anything running with a rich shell env).
  if (knownSecrets && knownSecrets.size) {
    for (const secret of knownSecrets) {
      if (!text.includes(secret)) continue;
      // Escape regex metacharacters in the secret before building the pattern.
      const esc = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(esc, "g"), () => { count++; return REDACTED; });
    }
  }

  return { text, redactionCount: count };
}

// Convenience wrapper for callers that only want the text.
export function redactString(input: string, knownSecrets?: ReadonlySet<string>): string {
  return redact(input, knownSecrets).text;
}
