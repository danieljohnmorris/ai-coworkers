// AIC-82 — reversible identifier masking. Cloud identifiers (cluster
// names, pod names, IP addresses, account IDs, RDS/EC2 instance ids)
// routinely appear in sensor output when a coworker reads Grafana /
// Datadog / CloudWatch responses. Sending them to an external LLM
// leaks prod internals — the identifiers themselves are the leak,
// distinct from the credential leak that secret_redaction covers.
//
// Layer diagram:
//   incoming sensor result / event
//     → pii_mask.mask()          ← THIS: identifiers → <CLUSTER_1> etc.
//     → deliberate() prompt      (LLM sees only masked names)
//     → decision.reason + action.input
//     → pii_mask.unmask()        ← restore before we present to human
//     → highlights.log + events.db
//
// Complements:
//   - secret_redaction: post-tool, pre-persistence — strips API keys.
//   - pii_mask (this):  post-sensor, pre-LLM — masks identifiers.
//
// Session-scoped: the substitution table lives for one tick or one
// deliberate turn. Two ticks looking at the same cluster should see
// the SAME token so the model can correlate — but different sessions
// use different tokens so leaks across sessions become detectable.

const PATTERNS: { name: string; re: RegExp }[] = [
  // Order matters: longer / more-specific patterns first so a shorter
  // one doesn't chew a fragment of a longer match.
  // AWS_ARN + UUID *contain* a 12-digit run that AWS_ACCOUNT would match
  // if it went first, so they precede it. Same principle for anything
  // else that wraps a shorter identifier.
  { name: "AWS_ARN",       re: /\barn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[A-Za-z0-9\-\/:_.*]+/g },
  { name: "UUID",          re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { name: "AWS_ACCOUNT",   re: /\b\d{12}\b/g },
  { name: "EC2_INSTANCE",  re: /\bi-[0-9a-f]{8,17}\b/g },
  { name: "EBS_VOLUME",    re: /\bvol-[0-9a-f]{8,17}\b/g },
  { name: "VPC",           re: /\bvpc-[0-9a-f]{8,17}\b/g },
  { name: "SUBNET",        re: /\bsubnet-[0-9a-f]{8,17}\b/g },
  { name: "SG",            re: /\bsg-[0-9a-f]{8,17}\b/g },
  { name: "K8S_POD",       re: /\b[a-z0-9]([-a-z0-9]{0,251}[a-z0-9])?-[a-f0-9]{8,10}-[a-z0-9]{5}\b/g }, // deployment-hash-suffix
  { name: "K8S_NAMESPACE", re: /\bns\/[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\b/g },
  { name: "RDS_INSTANCE",  re: /\bdb-[A-Z0-9]{16,32}\b/g },
  { name: "IPV4",          re: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g },
];

// Preserve identifiers that appear in legit shared contexts — the
// tokens the model needs verbatim to do useful work. Everything else
// is a candidate for masking.
const PRESERVE_EXACT = new Set([
  "0.0.0.0", "127.0.0.1", "255.255.255.255", "::1",
  "us-east-1", "us-west-2", "eu-west-1",  // AWS region names
]);

export interface MaskTable {
  // token (e.g. "<CLUSTER_1>") ↔ original ("prod-us-east-1-cluster-a")
  forward: Map<string, string>;
  reverse: Map<string, string>;
  // Per-pattern counter so tokens are stable within a session.
  counters: Map<string, number>;
}

export function newMaskTable(): MaskTable {
  return { forward: new Map(), reverse: new Map(), counters: new Map() };
}

export function mask(input: string, table: MaskTable = newMaskTable()): { masked: string; table: MaskTable } {
  if (!input) return { masked: input, table };
  let masked = input;
  for (const p of PATTERNS) {
    masked = masked.replace(p.re, (m) => {
      if (PRESERVE_EXACT.has(m)) return m;
      // Reuse an existing token if we've already masked this exact value.
      const existing = table.reverse.get(m);
      if (existing) return existing;
      const n = (table.counters.get(p.name) ?? 0) + 1;
      table.counters.set(p.name, n);
      const token = `<${p.name}_${n}>`;
      table.forward.set(token, m);
      table.reverse.set(m, token);
      return token;
    });
  }
  return { masked, table };
}

// Restore original identifiers. Idempotent — running it on already-
// unmasked text is a no-op (no tokens present → no replacements).
export function unmask(input: string, table: MaskTable): string {
  if (!input || table.forward.size === 0) return input;
  let out = input;
  // Iterate in reverse-insertion order so <CLUSTER_10> is replaced
  // before <CLUSTER_1> (regex boundaries would otherwise eat the "1").
  const tokens = [...table.forward.keys()].sort((a, b) => b.length - a.length);
  for (const t of tokens) {
    const original = table.forward.get(t)!;
    // Escape the token's < > for safe replaceAll.
    out = out.split(t).join(original);
  }
  return out;
}

// Convenience: mask an entire JSON-serialisable object recursively.
// Useful for hand-off — masks every string inside a sensor result
// before it lands in perception. Non-string leaves pass through.
export function maskDeep<T>(obj: T, table: MaskTable = newMaskTable()): { masked: T; table: MaskTable } {
  const rec = (v: unknown): unknown => {
    if (typeof v === "string") return mask(v, table).masked;
    if (Array.isArray(v)) return v.map(rec);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = rec(val);
      return out;
    }
    return v;
  };
  return { masked: rec(obj) as T, table };
}
