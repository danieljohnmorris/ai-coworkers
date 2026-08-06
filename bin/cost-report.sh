#!/usr/bin/env bash
# AIC-68 — cost dashboard, terminal edition. Reads events.db for one
# coworker (or all coworkers under coworkers/) and prints a per-model
# token + estimated cost breakdown for the last N days.
#
# Usage:
#   bin/cost-report.sh                    # last 7 days, all coworkers
#   bin/cost-report.sh alex-triage        # last 7 days, one coworker
#   bin/cost-report.sh alex-triage 30     # last 30 days
#
# Cost is best-effort — real pricing comes from your model vendor.
# Configure per-model rates in state/pricing.json (any coworker; global
# fallback), or leave unset for token-only output.
#
# Example pricing.json:
#   {
#     "gemma4:cloud":       { "prompt": 0.60, "completion": 1.80 },
#     "kimi-k2.7-code:cloud": { "prompt": 0.15, "completion": 0.60 }
#   }
# (values in USD per 1M tokens; per-1M is the convention most vendors use)

set -euo pipefail
target="${1:-}"
days="${2:-7}"

[[ "$days" =~ ^[0-9]+$ ]] || { echo "days must be a positive integer" >&2; exit 1; }
if [ -n "$target" ]; then
  [[ "$target" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "invalid coworker name" >&2; exit 1; }
fi

root="$(cd "$(dirname "$0")/.." && pwd)"

# Delegate to a small Node script — SQLite + JSON is easier than bash.
DAYS="$days" TARGET="$target" ROOT="$root" \
node --experimental-strip-types --no-warnings -e '
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const ROOT = process.env.ROOT;
  const DAYS = Number(process.env.DAYS);
  const TARGET = process.env.TARGET;
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();

  const coworkersDir = path.join(ROOT, "coworkers");
  const targets = TARGET
    ? [TARGET]
    : fs.readdirSync(coworkersDir).filter((n) => {
        try { return fs.statSync(path.join(coworkersDir, n)).isDirectory() && n !== "README.md" && !n.startsWith("."); }
        catch { return false; }
      });

  // Optional pricing table — per-1M-tokens USD.
  let pricing = {};
  for (const name of targets) {
    const p = path.join(coworkersDir, name, "state", "pricing.json");
    if (fs.existsSync(p)) {
      try { Object.assign(pricing, JSON.parse(fs.readFileSync(p, "utf8"))); }
      catch { /* skip malformed */ }
    }
  }
  const globalPricing = path.join(ROOT, "pricing.json");
  if (fs.existsSync(globalPricing)) {
    try { pricing = { ...JSON.parse(fs.readFileSync(globalPricing, "utf8")), ...pricing }; }
    catch { /* skip */ }
  }

  console.log(`Cost report — last ${DAYS} day(s), since ${since.slice(0, 16)}Z\n`);

  let grandCalls = 0, grandPrompt = 0, grandCompletion = 0, grandUsd = 0;

  for (const name of targets) {
    const dbPath = path.join(coworkersDir, name, "state", "events.db");
    if (!fs.existsSync(dbPath)) continue;
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare(
      "SELECT payload FROM events WHERE kind = ? AND ts >= ?"
    ).all("deliberate", since);
    if (rows.length === 0) continue;

    // Roll up per-model.
    const perModel = {};
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload);
        const m = p.model ?? "unknown";
        const bucket = perModel[m] ??= { calls: 0, prompt: 0, completion: 0 };
        bucket.calls += 1;
        if (typeof p.prompt_tokens === "number") bucket.prompt += p.prompt_tokens;
        if (typeof p.completion_tokens === "number") bucket.completion += p.completion_tokens;
      } catch { /* skip malformed */ }
    }

    console.log(`## ${name}`);
    const perNameCalls = Object.values(perModel).reduce((a, b) => a + b.calls, 0);
    const perNamePrompt = Object.values(perModel).reduce((a, b) => a + b.prompt, 0);
    const perNameCompletion = Object.values(perModel).reduce((a, b) => a + b.completion, 0);
    let perNameUsd = 0;
    console.log(`  ${"model".padEnd(30)} ${"calls".padStart(8)} ${"prompt".padStart(12)} ${"completion".padStart(12)} ${"usd".padStart(10)}`);
    for (const [m, b] of Object.entries(perModel)) {
      const price = pricing[m];
      const usd = price ? (b.prompt * price.prompt + b.completion * price.completion) / 1_000_000 : NaN;
      if (Number.isFinite(usd)) perNameUsd += usd;
      console.log(`  ${m.padEnd(30)} ${String(b.calls).padStart(8)} ${b.prompt.toLocaleString().padStart(12)} ${b.completion.toLocaleString().padStart(12)} ${Number.isFinite(usd) ? ("$" + usd.toFixed(2)).padStart(10) : "-".padStart(10)}`);
    }
    console.log(`  ${"total".padEnd(30)} ${String(perNameCalls).padStart(8)} ${perNamePrompt.toLocaleString().padStart(12)} ${perNameCompletion.toLocaleString().padStart(12)} ${perNameUsd ? ("$" + perNameUsd.toFixed(2)).padStart(10) : "-".padStart(10)}`);
    console.log("");
    grandCalls += perNameCalls; grandPrompt += perNamePrompt; grandCompletion += perNameCompletion; grandUsd += perNameUsd;
  }

  if (targets.length > 1) {
    console.log(`## Total across ${targets.length} coworkers`);
    console.log(`  calls=${grandCalls}  prompt=${grandPrompt.toLocaleString()}  completion=${grandCompletion.toLocaleString()}  usd=${grandUsd ? "$" + grandUsd.toFixed(2) : "-"}`);
  }
  if (Object.keys(pricing).length === 0) {
    console.log("\n(No pricing table found. Drop a pricing.json at ROOT or coworkers/<name>/state/ with { model: {prompt, completion} } in USD per 1M tokens.)");
  }
'
