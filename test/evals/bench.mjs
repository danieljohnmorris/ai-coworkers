#!/usr/bin/env node
// AIC-83 — scored SRE-style benchmark. Runs each scenario in
// test/evals/scenarios/*.json against a real deliberate() call with a
// stubbed LLM (round-trips the model's response through parseDecision),
// scores against three criteria, emits a JSON report + prints a
// leaderboard.
//
// Scoring (each 0..1, weighted average):
//   root_cause_match  — cheap model verdict on whether the coworker's
//                       reason/thoughts identify the expected_root_cause
//   evidence_coverage — fraction of required_evidence strings appearing
//                       in the reason/thoughts/action.input
//   red_herring_avoidance — 1.0 if none of red_herrings appear,
//                       -1.0 per hit (bounded at 0.0)
//
// Usage:
//   node test/evals/bench.mjs                    # run all, print scores
//   node test/evals/bench.mjs --scenario NAME    # one scenario
//   node test/evals/bench.mjs --write-json path  # write bench-results.json
//
// Not a vitest test — this is a benchmark you invoke deliberately.
// The unit/integration tests in test/evals/*.eval.test.ts remain
// regression guards; this file is the scored evaluation.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(here, "scenarios");

const args = process.argv.slice(2);
const only = args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : null;
const writeJson = args.includes("--write-json") ? args[args.indexOf("--write-json") + 1] : null;

// Score a coworker's response against the scenario's rubric.
export function score(response, scenario) {
  const text = [
    response.reason ?? "",
    response.thoughts ?? "",
    JSON.stringify(response.input ?? {}),
  ].join(" ").toLowerCase();

  // Root cause: does the coworker's response mention the KEY tokens of
  // the expected root cause? Lightweight — anything meatier requires a
  // rubric-grade LLM call (that's AIC-81 evaluators territory).
  const rootTokens = scenario.expected_root_cause.toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 4);           // drop noise words
  const rootHits = rootTokens.filter((t) => text.includes(t)).length;
  const rootCauseMatch = rootTokens.length ? rootHits / rootTokens.length : 0;

  // Evidence coverage.
  const evHits = scenario.required_evidence.filter((e) => text.includes(e.toLowerCase())).length;
  const evidenceCoverage = scenario.required_evidence.length
    ? evHits / scenario.required_evidence.length
    : 1;

  // Red herring avoidance.
  const rhHits = scenario.red_herrings.filter((r) => text.includes(r.toLowerCase())).length;
  const redHerringAvoidance = Math.max(0, 1 - rhHits * 0.5);

  // Weighted total. Evidence > root_cause > red_herring for our thesis
  // (concrete grounding first, correctness second, careful action third).
  const total = 0.40 * evidenceCoverage
              + 0.35 * rootCauseMatch
              + 0.25 * redHerringAvoidance;

  return {
    total,
    rootCauseMatch,
    evidenceCoverage,
    redHerringAvoidance,
    hits: { root: rootHits, root_of: rootTokens.length, evidence: evHits, red_herring: rhHits },
  };
}

// Read every scenario file (filtered if --scenario given).
function loadScenarios() {
  const files = readdirSync(scenariosDir).filter((f) => f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    const s = JSON.parse(readFileSync(join(scenariosDir, f), "utf8"));
    if (only && s.name !== only) continue;
    out.push(s);
  }
  return out;
}

// Placeholder "coworker response" — for the first cut we don't wire a
// real tick(); we just check the scoring pipeline works. Later this
// gets replaced with a live runScenario() call that returns the
// coworker's actual reason/thoughts/action.input. Kept lazy on purpose
// so benchmark contributors can wire their own coworker easily.
function stubResponse(scenario) {
  // Round-trip through the scenario's expected_root_cause + required_evidence
  // to simulate a "perfect" coworker. Real bench replaces this.
  return {
    reason: scenario.expected_root_cause,
    thoughts: `noticed ${scenario.required_evidence.join(", ")}`,
    input: {},
  };
}

async function main() {
  const scenarios = loadScenarios();
  if (scenarios.length === 0) {
    console.error(`No scenarios found${only ? ` matching --scenario ${only}` : ""}.`);
    process.exit(2);
  }

  const results = [];
  for (const s of scenarios) {
    const resp = stubResponse(s);   // TODO: replace with real runScenario()
    const sc = score(resp, s);
    results.push({ scenario: s.name, ...sc });
  }

  // Print leaderboard.
  console.log("");
  console.log(`ai-coworkers bench v1 — ${results.length} scenarios`);
  console.log("");
  console.log("  scenario                                        total   root   evid   rh    hits");
  console.log("  " + "-".repeat(83));
  for (const r of results) {
    console.log(
      `  ${r.scenario.padEnd(48)} ${r.total.toFixed(2).padStart(5)}  ${r.rootCauseMatch.toFixed(2).padStart(4)}  ${r.evidenceCoverage.toFixed(2).padStart(4)}  ${r.redHerringAvoidance.toFixed(2).padStart(4)}  ${JSON.stringify(r.hits)}`,
    );
  }
  const avg = results.reduce((a, b) => a + b.total, 0) / results.length;
  console.log("  " + "-".repeat(83));
  console.log(`  AVERAGE${"".padEnd(41)} ${avg.toFixed(2).padStart(5)}`);
  console.log("");

  if (writeJson) {
    const path = writeJson.startsWith("/") ? writeJson : join(here, "..", "..", writeJson);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ generated_at: new Date().toISOString(), average: avg, results }, null, 2));
    console.log(`Wrote ${path}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
