// Entry point. Usage:
//   node --experimental-strip-types --no-warnings src/index.ts <coworker> [--live]
// Default is dry-run. Pass --live to allow write actions to actually execute.

import { mkdirSync, appendFileSync, watch } from "node:fs";
import { join } from "node:path";
import { loadRole } from "./runtime/role.ts";
import { openEvents, Log } from "./runtime/log.ts";
import { openMemory } from "./runtime/memory.ts";
import { openHygiene } from "./runtime/hygiene.ts";
import { openSemantic } from "./runtime/semantic.ts";
import { initEpisodic } from "./runtime/episodic.ts";
import { openEntities } from "./runtime/entities.ts";
import { openInbox } from "./runtime/inbox.ts";
import { openReactions } from "./runtime/reactions.ts";
import { ToolRegistry } from "./runtime/tools.ts";
import { tick } from "./runtime/tick.ts";
import { linearTools } from "./tools/linear.ts";
import { memoryTools } from "./tools/memory.ts";
import { githubTools } from "./tools/github.ts";
import { slackTools } from "./tools/slack.ts";
import { askTools } from "./tools/ask.ts";
import { roleTools } from "./tools/role.ts";
import { codeDelegateTools } from "./tools/code_delegate.ts";
import { branchRoomTools } from "./tools/branch_room.ts";
import { connectMcp, parseMcpEnv, type McpConnection } from "./adapters/mcp.ts";
import { loadCoworkerEnv } from "./runtime/credentials.ts";
import { knownSecretsFrom } from "./runtime/secret_redaction.ts";
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

  // Per-coworker env — reads coworkers/<name>/.env (gitignored) and overlays
  // it on the shell env. Lets Alex point at Cubitts Linear while another
  // coworker in the same repo uses a different key, without either polluting
  // process.env for the other. See src/runtime/credentials.ts.
  const coworkerEnv = loadCoworkerEnv(coworkersDir, name);

  let role = loadRole(coworkersDir, name);
  const events = openEvents(join(stateDir, "events.db"));
  initEpisodic(events);
  const memory = openMemory(join(stateDir, "memory.db"));
  const hygiene = openHygiene(join(stateDir, "hygiene.db"));
  const semantic = openSemantic(join(stateDir, "memory", "MEMORY.md"));
  const entities = openEntities(join(stateDir, "entities"));
  const inbox = openInbox(join(stateDir, "inbox.md"));
  const reactions = openReactions(join(stateDir, "reactions.log"));
  const log = new Log(events, name, {
    streamPath: join(stateDir, "stream.log"),
    highlightPath: join(stateDir, "highlights.log"),
    // Pass the coworker's env-derived secret set so anything about to
    // land in events.db / stream.log / highlights.log is scrubbed.
    knownSecrets: knownSecretsFrom(coworkerEnv),
  });

  const tools = new ToolRegistry();
  for (const t of linearTools) tools.register(t);
  for (const t of memoryTools) tools.register(t);
  for (const t of githubTools) tools.register(t);
  for (const t of slackTools) tools.register(t);
  for (const t of askTools) tools.register(t);
  for (const t of roleTools) tools.register(t);
  for (const t of codeDelegateTools) tools.register(t);
  for (const t of branchRoomTools) tools.register(t);

  // Optional MCP servers via MCP_SERVERS env var.
  const mcpConnections: McpConnection[] = [];
  for (const serverCfg of parseMcpEnv(coworkerEnv)) {
    try {
      const conn = await connectMcp(serverCfg, hygiene);
      for (const t of conn.tools) tools.register(t);
      mcpConnections.push(conn);
      log.stream(`mcp: connected ${serverCfg.name} (${conn.tools.length} tools)`);
    } catch (err) {
      log.stream(`mcp: failed to connect ${serverCfg.name}: ${err}`);
    }
  }

  // Optional Hermes-style skills dir (defaults to ~/.hermes/skills if it exists).
  const skillsDir = coworkerEnv.SKILLS_DIR ?? join(process.env.HOME ?? "", ".hermes", "skills");
  const skills = loadHermesSkills(skillsDir);
  const activeSkills = (coworkerEnv.ACTIVE_SKILLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const skillsIndex = renderSkillsIndex(skills, activeSkills);
  if (skills.length) log.stream(`skills: ${skills.length} loaded from ${skillsDir}`);
  if (skillsIndex) role = { ...role, systemPrompt: `${role.systemPrompt}\n\n---\n\n${skillsIndex}` };

  const llm = {
    baseUrl: coworkerEnv.OLLAMA_HOST ?? "https://ollama.com",
    apiKey: coworkerEnv.OLLAMA_API_KEY,
    model: coworkerEnv.COWORKER_MODEL ?? "gemma4:cloud",
  };
  // AIC-47 — optional cheap-first preflight. Set TRIAGE_MODEL to a small
  // model on the same OLLAMA_HOST; when set, every tick asks it "act or
  // skip?" before spending the expensive COWORKER_MODEL prompt.
  const triageLlm = coworkerEnv.TRIAGE_MODEL
    ? { baseUrl: coworkerEnv.OLLAMA_HOST ?? "https://ollama.com", apiKey: coworkerEnv.OLLAMA_API_KEY, model: coworkerEnv.TRIAGE_MODEL }
    : undefined;

  log.stream(`start coworker=${name} model=${llm.model} live=${live}`);
  log.event("note", { message: "startup", model: llm.model, live });

  // AIC-58 — hot-reload role docs on change. Watch role/ recursively;
  // any .md or .json edit re-parses the role + re-applies the skills
  // index. Debounced (300ms) because editors save-and-swap fires
  // multiple events per save. rituals/*.json is already re-read every
  // tick by rituals_loader, so we don't need to force a reload for that
  // — but do log so an operator sees the change was noticed.
  const roleDir = join(coworkersDir, name, "role");
  let reloadTimer: NodeJS.Timeout | null = null;
  const reload = (): void => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      try {
        const fresh = loadRole(coworkersDir, name);
        role = skillsIndex ? { ...fresh, systemPrompt: `${fresh.systemPrompt}\n\n---\n\n${skillsIndex}` } : fresh;
        log.event("role.reload", { ok: true });
        log.highlight(`🔁 role reloaded (limits: max ${role.limits.maxLlmPerDay ?? "?"} LLM/day, ${role.limits.maxWorktrees} worktrees)`);
      } catch (err) {
        log.event("role.reload", { ok: false, error: String(err) });
        log.highlight(`✗ role reload failed: ${err}`);
      }
    }, 300);
  };
  try {
    const watcher = watch(roleDir, { recursive: true }, (_evt, filename) => {
      if (!filename) return;
      const f = String(filename);
      if (f.endsWith(".md") || f.endsWith(".json")) reload();
    });
    log.stream(`role hot-reload: watching ${roleDir}`);
    process.on("SIGINT", () => { try { watcher.close(); } catch { /* noop */ } });
    process.on("SIGTERM", () => { try { watcher.close(); } catch { /* noop */ } });
  } catch (err) {
    // fs.watch is best-effort on some platforms (network mounts etc).
    // Log and continue — worst case the operator has to restart.
    log.event("note", { message: "role hot-reload unavailable", error: String(err) });
  }

  const baseIntervalMs = Number(coworkerEnv.TICK_INTERVAL_MS ?? 5 * 60_000);
  const maxIntervalMs = role.cadence === "constant"
    ? baseIntervalMs                       // no backoff when role is "constant"
    : Number(coworkerEnv.MAX_TICK_INTERVAL_MS ?? 30 * 60_000);
  let intervalMs = baseIntervalMs;
  let consecutiveQuiet = 0;
  const stop = { flag: false };
  const wake = { flag: false };            // event-driven wake trigger

  // Optional HTTP /wake endpoint (WAKE_PORT env). Lets Linear/Slack/GitHub
  // webhooks (or any curl) fire an immediate tick.
  const wakePort = Number(coworkerEnv.WAKE_PORT ?? 0);
  if (wakePort > 0) {
    startWakeServer(wakePort, wake, {
      secret: coworkerEnv.WAKE_SECRET,
      events,
      coworkerName: name,
      metricsEnabled: coworkerEnv.METRICS_ENABLED === "1",
    });
    log.stream(`wake endpoint: http://127.0.0.1:${wakePort}/wake`);
    if (coworkerEnv.METRICS_ENABLED === "1") log.stream(`metrics endpoint: http://127.0.0.1:${wakePort}/metrics`);
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
  let forceNext = false;
  while (!stop.flag) {
    let outcome = { quiet: false };
    try {
      outcome = await tick({
        role, events, memory, hygiene, semantic, entities, inbox, reactions,
        tools, llm, triageLlm, dryRun: !live, log,
        forceDeliberate: forceNext,
        env: coworkerEnv,
      });
      forceNext = false;
    } catch (err) {
      log.event("note", { fatal: false, error: String(err) });
      log.stream(`tick error: ${err}`);
    }
    // Coworker-chosen pacing hint (bounded by env limits). Overrides the
    // adaptive quiet/reset rule when explicit — the model owns the wheel.
    const minMs = Number(coworkerEnv.MIN_TICK_INTERVAL_MS ?? 15_000);
    if (outcome.pace === "faster") {
      intervalMs = Math.max(minMs, Math.floor(intervalMs / 2));
      consecutiveQuiet = 0;
      log.stream(`pace=faster — next tick in ${Math.round(intervalMs / 1000)}s`);
    } else if (outcome.pace === "slower") {
      intervalMs = Math.min(maxIntervalMs, intervalMs * 2);
      log.stream(`pace=slower — next tick in ${Math.round(intervalMs / 1000)}s`);
    } else if (outcome.pace === "hold") {
      log.stream(`pace=hold — next tick in ${Math.round(intervalMs / 1000)}s`);
    } else if (outcome.quiet || outcome.didNoAction) {
      // Either a quiet-skipped tick OR a tick where deliberation ran but
      // chose to do nothing → back off. Repeatedly deciding "nothing to do"
      // should not keep us spinning at base cadence.
      consecutiveQuiet++;
      intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
      log.stream(`idle x${consecutiveQuiet} — next tick in ${Math.round(intervalMs / 1000)}s`);
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
      forceNext = true;                    // bypass quiet gate — they poked us
      log.stream(`woken by event — next tick immediately`);
    }
  }
  log.event("note", { message: "shutdown" });
  // AIC-44 — cleanly close all MCP subprocesses before exiting.
  for (const c of mcpConnections) await c.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
