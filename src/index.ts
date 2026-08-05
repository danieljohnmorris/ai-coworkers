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
import { ToolRegistry } from "./runtime/tools.ts";
import { tick } from "./runtime/tick.ts";
import { linearTools } from "./tools/linear.ts";

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

  const role = loadRole(coworkersDir, name);
  const events = openEvents(join(stateDir, "events.db"));
  const memory = openMemory(join(stateDir, "memory.db"));
  const hygiene = openHygiene(join(stateDir, "hygiene.db"));
  const semantic = openSemantic(join(stateDir, "memory", "MEMORY.md"));
  const log = new Log(events, name);

  const tools = new ToolRegistry();
  for (const t of linearTools) tools.register(t);

  const llm = {
    baseUrl: process.env.OLLAMA_HOST ?? "https://ollama.com",
    apiKey: process.env.OLLAMA_API_KEY,
    model: process.env.COWORKER_MODEL ?? "gemma4:cloud",
  };

  log.stream(`start coworker=${name} model=${llm.model} live=${live}`);
  log.event("note", { message: "startup", model: llm.model, live });

  const intervalMs = Number(process.env.TICK_INTERVAL_MS ?? 5 * 60_000);
  const stop = { flag: false };
  const onSig = () => {
    log.stream(`shutdown signal`);
    stop.flag = true;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  // Simple loop; event-driven wake-ups can be layered later.
  while (!stop.flag) {
    try {
      await tick({
        role,
        events,
        memory,
        hygiene,
        semantic,
        tools,
        llm,
        dryRun: !live,
        log,
      });
    } catch (err) {
      log.event("note", { fatal: false, error: String(err) });
      log.stream(`tick error: ${err}`);
    }
    // sleep in small slices so we exit promptly on signal
    const wake = Date.now() + intervalMs;
    while (!stop.flag && Date.now() < wake) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  log.event("note", { message: "shutdown" });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
