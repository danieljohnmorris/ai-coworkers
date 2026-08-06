#!/usr/bin/env node
// AIC-83 — scored SRE-style benchmark. For each scenario in
// test/evals/scenarios/*.json, spins up a real coworker, wires the
// scenario's sensors, drops the scenario.prompt into the inbox, runs
// one tick with a REAL LLM (from OLLAMA_API_KEY or an override), then
// scores the coworker's actual deliberate output against the rubric.
//
// No stubs. If OLLAMA_API_KEY is unset the harness exits with a clear
// message rather than pretending to score something.
//
// Usage:
//   OLLAMA_API_KEY=... node test/evals/bench.mjs
//   node test/evals/bench.mjs --scenario NAME
//   node test/evals/bench.mjs --write-json test/evals/bench-results.json
//   node test/evals/bench.mjs --model claude-haiku-4-5   # override BENCH_MODEL / COWORKER_MODEL

import { readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(here, "scenarios");
const repoRoot = join(here, "..", "..");

const args = process.argv.slice(2);
const only = args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : null;
const writeJson = args.includes("--write-json") ? args[args.indexOf("--write-json") + 1] : null;
const modelOverride = args.includes("--model") ? args[args.indexOf("--model") + 1] : null;

// -------- scoring (exported for the unit test) --------

export function score(response, scenario) {
  const text = [
    response.reason ?? "",
    response.thoughts ?? "",
    JSON.stringify(response.input ?? {}),
  ].join(" ").toLowerCase();

  const rootTokens = scenario.expected_root_cause.toLowerCase()
    .split(/\W+/).filter((w) => w.length > 4);
  const rootHits = rootTokens.filter((t) => text.includes(t)).length;
  const rootCauseMatch = rootTokens.length ? rootHits / rootTokens.length : 0;

  const evHits = scenario.required_evidence.filter((e) => text.includes(e.toLowerCase())).length;
  const evidenceCoverage = scenario.required_evidence.length
    ? evHits / scenario.required_evidence.length : 1;

  const rhHits = scenario.red_herrings.filter((r) => text.includes(r.toLowerCase())).length;
  const redHerringAvoidance = Math.max(0, 1 - rhHits * 0.5);

  const total = 0.40 * evidenceCoverage
              + 0.35 * rootCauseMatch
              + 0.25 * redHerringAvoidance;

  return { total, rootCauseMatch, evidenceCoverage, redHerringAvoidance,
           hits: { root: rootHits, root_of: rootTokens.length, evidence: evHits, red_herring: rhHits } };
}

// -------- real coworker run --------

async function runOne(scenario, llmCfg) {
  const dir = mkdtempSync(join(tmpdir(), "bench-"));
  try {
    const name = "bench";
    const roleDir = join(dir, "coworkers", name, "role");
    const stateDir = join(dir, "coworkers", name, "state");
    mkdirSync(roleDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(roleDir, "ROLE.md"), `You are a bench-run coworker in role: ${scenario.role}.`);
    writeFileSync(join(roleDir, "RESPONSIBILITIES.md"), "- Diagnose the reported situation using the sensor output. Reply with a concrete root cause and evidence in your `reason` + `thoughts` fields. Cite specific identifiers from the sensor output. Do NOT propose destructive actions; noop with a detailed reason is fine.");
    writeFileSync(join(roleDir, "AUTHORITY.md"), "Decide alone; you may propose but not execute.");
    writeFileSync(join(roleDir, "BOUNDARIES.md"), "## Must not touch\n- production\n\n## Resource limits\n- Max LLM calls per day: 500");
    writeFileSync(join(roleDir, "RITUALS.md"), "## Tempo\n- reply once per prompt, terse but specific");
    writeFileSync(join(roleDir, "RELATIONSHIPS.md"), "-");
    writeFileSync(join(roleDir, "TOOLS.md"), "- fake");
    writeFileSync(join(roleDir, "WORKSPACE.md"), scenario.prompt);

    // Prompt lands in the inbox — treated as an unread note from manager,
    // guaranteed to appear in this tick's perception.
    writeFileSync(join(stateDir, "inbox.md"), `## ${new Date().toISOString()}\n${scenario.prompt}\n\n`);

    const { tick } = await import(join(repoRoot, "src/runtime/tick.ts"));
    const { openEvents, Log } = await import(join(repoRoot, "src/runtime/log.ts"));
    const { openMemory } = await import(join(repoRoot, "src/runtime/memory.ts"));
    const { openHygiene } = await import(join(repoRoot, "src/runtime/hygiene.ts"));
    const { openSemantic } = await import(join(repoRoot, "src/runtime/semantic.ts"));
    const { openEntities } = await import(join(repoRoot, "src/runtime/entities.ts"));
    const { openInbox } = await import(join(repoRoot, "src/runtime/inbox.ts"));
    const { openReactions } = await import(join(repoRoot, "src/runtime/reactions.ts"));
    const { initEpisodic } = await import(join(repoRoot, "src/runtime/episodic.ts"));
    const { _resetForTests: resetCircuit } = await import(join(repoRoot, "src/runtime/circuit.ts"));
    const { ToolRegistry } = await import(join(repoRoot, "src/runtime/tools.ts"));
    const { loadRole } = await import(join(repoRoot, "src/runtime/role.ts"));
    resetCircuit();

    const events = openEvents(join(stateDir, "events.db"));
    initEpisodic(events);
    const role = loadRole(join(dir, "coworkers"), name);
    const tools = new ToolRegistry();
    for (const s of scenario.sensors ?? []) {
      tools.register({
        name: s.name, kind: "sensor", description: `stub ${s.name}`, inputSchema: { type: "object" },
        handler: async () => s.result,
      });
    }
    tools.register({
      name: "fake.reply", kind: "action",
      description: "Emit a diagnosis (noop preferred).", inputSchema: { type: "object" },
      handler: async () => ({ ok: true }),
    });

    // Silence stdout noise from the tick loop during bench runs.
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      await tick({
        role, events,
        memory: openMemory(join(stateDir, "memory.db")),
        hygiene: openHygiene(join(stateDir, "hygiene.db")),
        semantic: openSemantic(join(stateDir, "memory", "MEMORY.md")),
        entities: openEntities(join(stateDir, "entities")),
        inbox: openInbox(join(stateDir, "inbox.md")),
        reactions: openReactions(join(stateDir, "reactions.log")),
        tools, llm: llmCfg, dryRun: true,
        log: new Log(events, name),
        env: process.env,
      });
    } finally {
      process.stdout.write = origWrite;
    }

    // Coworker's reply = every deliberate event's reason+thoughts concatenated,
    // plus the last action.input (if any) so an action-shaped answer scores too.
    const dels = events.prepare("SELECT payload FROM events WHERE kind='deliberate' ORDER BY id ASC").all();
    const acts = events.prepare("SELECT payload FROM events WHERE kind='action' ORDER BY id ASC").all();
    const combined = { reason: "", thoughts: "", input: {}, tool: null };
    for (const r of dels) {
      const p = JSON.parse(r.payload);
      if (p.reason)   combined.reason   += (combined.reason   ? " " : "") + p.reason;
      if (p.thoughts) combined.thoughts += (combined.thoughts ? " " : "") + p.thoughts;
      if (p.tool)     combined.tool = p.tool;
    }
    if (acts.length) {
      const last = JSON.parse(acts[acts.length - 1].payload);
      if (last.input) combined.input = last.input;
    }
    return combined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// -------- main --------

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

async function main() {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    console.error("bench: OLLAMA_API_KEY not set. This benchmark makes real LLM calls;");
    console.error("       set OLLAMA_API_KEY (or your provider's equivalent — same var the runtime reads)");
    console.error("       then re-run. See docs/tool-cookbook.md for the LLM config story.");
    process.exit(2);
  }
  const llmCfg = {
    baseUrl: process.env.OLLAMA_HOST ?? "https://ollama.com",
    apiKey,
    model: modelOverride ?? process.env.BENCH_MODEL ?? process.env.COWORKER_MODEL ?? "gemma4:cloud",
  };

  const scenarios = loadScenarios();
  if (scenarios.length === 0) {
    console.error(`No scenarios found${only ? ` matching --scenario ${only}` : ""}.`);
    process.exit(2);
  }

  console.log("");
  console.log(`ai-coworkers bench v1 — ${scenarios.length} scenarios × 1 run, model=${llmCfg.model}`);
  console.log("");

  const results = [];
  for (const s of scenarios) {
    process.stderr.write(`  running: ${s.name}…\r`);
    const t0 = Date.now();
    let resp;
    try { resp = await runOne(s, llmCfg); }
    catch (err) { resp = { reason: "", thoughts: `bench error: ${err.message ?? err}`, input: {} }; }
    const sc = score(resp, s);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    results.push({ scenario: s.name, elapsed_s: Number(elapsed), ...sc, response: resp });
    process.stderr.write(" ".repeat(80) + "\r");
  }

  console.log("  scenario                                        total   root   evid   rh    time   hits");
  console.log("  " + "-".repeat(94));
  for (const r of results) {
    console.log(
      `  ${r.scenario.padEnd(48)} ${r.total.toFixed(2).padStart(5)}  ${r.rootCauseMatch.toFixed(2).padStart(4)}  ${r.evidenceCoverage.toFixed(2).padStart(4)}  ${r.redHerringAvoidance.toFixed(2).padStart(4)}  ${(r.elapsed_s + "s").padStart(5)}  ${JSON.stringify(r.hits)}`,
    );
  }
  const avg = results.reduce((a, b) => a + b.total, 0) / results.length;
  console.log("  " + "-".repeat(94));
  console.log(`  AVERAGE${"".padEnd(41)} ${avg.toFixed(2).padStart(5)}`);
  console.log("");

  if (writeJson) {
    const path = writeJson.startsWith("/") ? writeJson : join(repoRoot, writeJson);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      generated_at: new Date().toISOString(),
      model: llmCfg.model,
      average: avg,
      results,
    }, null, 2));
    console.log(`Wrote ${path}`);
  }
}

// Only run main when invoked directly (not when imported by bench.test.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
