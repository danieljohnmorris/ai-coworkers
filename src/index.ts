// Entry point. Usage:
//   node --experimental-strip-types --no-warnings src/index.ts <coworker> [--live]
// Default is dry-run. Pass --live to allow write actions to actually execute.

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadRole } from "./runtime/role.ts";
import { openEvents, Log } from "./runtime/log.ts";
import { openMemory } from "./runtime/memory.ts";
import { openHygiene } from "./runtime/hygiene.ts";
import { openSemantic } from "./runtime/semantic.ts";
import { initEpisodic } from "./runtime/episodic.ts";
import { openEntities } from "./runtime/entities.ts";
import { ToolRegistry } from "./runtime/tools.ts";
import { tick } from "./runtime/tick.ts";
import { linearTools } from "./tools/linear.ts";
import { memoryTools } from "./tools/memory.ts";
import { githubTools } from "./tools/github.ts";
import { connectMcp, parseMcpEnv, type McpConnection } from "./adapters/mcp.ts";
import { loadHermesSkills, renderSkillsIndex } from "./adapters/hermes.ts";
import { startWakeServer } from "./runtime/wake.ts";

async function main() {
  const args = process.argv.slice(2);
  const name = args[0];
  const live = args.includes("--live");
  if (!name) {
    console.error("usage: coworker <name> [--live]");
    process.exit(1);
  }

  const repoRoot = new URL("..", import.meta.url).pathname;
  const coworkersDir = join(repoRoot, "coworkers");
  const stateDir = join(coworkersDir, name, "state");
  mkdirSync(stateDir, { recursive: true });

  // Crash log — captures anything that kills the process before the event log
  // exists. Path is stable so `tail -f` works across runs.
  const crashLog = join(stateDir, "crash.log");
  const crash = (label: string, err: unknown): void => {
    const line = `[${new Date().toISOString()}] ${label}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`;
    try { appendFileSync(crashLog, line); } catch {}
    try { process.stderr.write(line); } catch {}
  };
  process.on("uncaughtException", (e) => crash("uncaughtException", e));
  process.on("unhandledRejection", (e) => crash("unhandledRejection", e));

  let role = loadRole(coworkersDir, name);
  const events = openEvents(join(stateDir, "events.db"));
  initEpisodic(events);
  const memory = openMemory(join(stateDir, "memory.db"));
  const hygiene = openHygiene(join(stateDir, "hygiene.db"));
  const semantic = openSemantic(join(stateDir, "memory", "MEMORY.md"));
  const entities = openEntities(join(stateDir, "entities"));
  const log = new Log(events, name);

  const tools = new ToolRegistry();
  for (const t of linearTools) tools.register(t);
  for (const t of memoryTools) tools.register(t);
  for (const t of githubTools) tools.register(t);

  // Optional MCP servers via MCP_SERVERS env var.
  const mcpConnections: McpConnection[] = [];
  for (const serverCfg of parseMcpEnv(process.env)) {
    try {
      const conn = await connectMcp(serverCfg);
      for (const t of conn.tools) tools.register(t);
      mcpConnections.push(conn);
      log.stream(`mcp: connected ${serverCfg.name} (${conn.tools.length} tools)`);
    } catch (err) {
      log.stream(`mcp: failed to connect ${serverCfg.name}: ${err}`);
    }
  }

  // Optional Hermes-style skills dir (defaults to ~/.hermes/skills if it exists).
  const skillsDir = process.env.SKILLS_DIR ?? join(process.env.HOME ?? "", ".hermes", "skills");
  const skills = loadHermesSkills(skillsDir);
  const activeSkills = (process.env.ACTIVE_SKILLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const skillsIndex = renderSkillsIndex(skills, activeSkills);
  if (skills.length) log.stream(`skills: ${skills.length} loaded from ${skillsDir}`);
  if (skillsIndex) role = { ...role, systemPrompt: `${role.systemPrompt}\n\n---\n\n${skillsIndex}` };

  const llm = {
    baseUrl: process.env.OLLAMA_HOST ?? "https://ollama.com",
    apiKey: process.env.OLLAMA_API_KEY,
    model: process.env.COWORKER_MODEL ?? "gemma4:cloud",
  };

  log.stream(`start coworker=${name} model=${llm.model} live=${live}`);
  log.event("note", { message: "startup", model: llm.model, live });

  const baseIntervalMs = Number(process.env.TICK_INTERVAL_MS ?? 5 * 60_000);
  const maxIntervalMs = role.cadence === "constant"
    ? baseIntervalMs                       // no backoff when role is "constant"
    : Number(process.env.MAX_TICK_INTERVAL_MS ?? 30 * 60_000);
  let intervalMs = baseIntervalMs;
  let consecutiveQuiet = 0;
  const stop = { flag: false };
  const wake = { flag: false };            // event-driven wake trigger

  // Optional HTTP /wake endpoint (WAKE_PORT env). Lets Linear/Slack/GitHub
  // webhooks (or any curl) fire an immediate tick.
  const wakePort = Number(process.env.WAKE_PORT ?? 0);
  if (wakePort > 0) {
    startWakeServer(wakePort, wake, process.env.WAKE_SECRET);
    log.stream(`wake endpoint: http://127.0.0.1:${wakePort}/wake`);
  }
  const onSig = () => {
    log.stream(`shutdown signal`);
    stop.flag = true;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  // Adaptive tick loop. After each quiet tick the interval doubles up to
  // maxIntervalMs; any real tick (deliberation ran) resets to baseIntervalMs.
  // Keeps quiet coworkers cheap without missing new signals for long.
  while (!stop.flag) {
    let outcome = { quiet: false };
    try {
      outcome = await tick({
        role, events, memory, hygiene, semantic, entities,
        tools, llm, dryRun: !live, log,
      });
    } catch (err) {
      log.event("note", { fatal: false, error: String(err) });
      log.stream(`tick error: ${err}`);
    }
    if (outcome.quiet) {
      consecutiveQuiet++;
      intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
      log.stream(`quiet x${consecutiveQuiet} — next tick in ${Math.round(intervalMs / 1000)}s`);
    } else if (consecutiveQuiet > 0) {
      consecutiveQuiet = 0;
      intervalMs = baseIntervalMs;
      log.stream(`activity resumed — interval reset to ${Math.round(intervalMs / 1000)}s`);
    }
    // sleep in small slices so we exit promptly on signal OR /wake
    const wakeAt = Date.now() + intervalMs;
    while (!stop.flag && !wake.flag && Date.now() < wakeAt) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (wake.flag) {
      wake.flag = false;
      intervalMs = baseIntervalMs;         // reset backoff on external wake
      consecutiveQuiet = 0;
      log.stream(`woken by event — next tick immediately`);
    }
  }
  log.event("note", { message: "shutdown" });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
