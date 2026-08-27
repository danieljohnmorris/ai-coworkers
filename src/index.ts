// Entry point. Usage:
//   node --experimental-strip-types --no-warnings src/index.ts <coworker> [--live]
// Default is dry-run. Pass --live to allow write actions to actually execute.

import { mkdirSync, appendFileSync, watch } from "node:fs";
import { join } from "node:path";
import { loadRole } from "./runtime/role.ts";
import { openEvents, Log, renderModeBanner, terminalTitleEscape } from "./runtime/log.ts";
import { openMemory } from "./runtime/memory.ts";
import { openHygiene } from "./runtime/hygiene.ts";
import { openSemantic } from "./runtime/semantic.ts";
import { initEpisodic } from "./runtime/episodic.ts";
import { openEntities } from "./runtime/entities.ts";
import { openInbox } from "./runtime/inbox.ts";
import { openReactions } from "./runtime/reactions.ts";
import { ToolRegistry } from "./runtime/tools.ts";
import { tick } from "./runtime/tick.ts";
import { memoryTools } from "./tools/memory.ts";
import { githubTools } from "./tools/github.ts";
import { slackTools } from "./tools/slack.ts";
import { askTools } from "./tools/ask.ts";
import { roleTools } from "./tools/role.ts";
import { codeDelegateTools } from "./tools/code_delegate.ts";
import { branchRoomTools } from "./tools/branch_room.ts";
import { gmailTools } from "./tools/gmail.ts";
import { memWalkTools } from "./tools/mem_walk.ts";
import { connectMcp, parseMcpEnv, type McpConnection } from "./adapters/mcp.ts";
import { loadCoworkerEnv } from "./runtime/credentials.ts";
import { loadCoworkerConfig } from "./runtime/coworker_config.ts";
import { knownSecretsFrom } from "./runtime/secret_redaction.ts";
import { loadHermesSkills, renderSkillsIndex } from "./adapters/hermes.ts";
import { startWakeServer } from "./runtime/wake.ts";
import { parseWakeMode } from "./runtime/wake_mode.ts";
import { isInHours, describeHours } from "./runtime/work_hours.ts";
import { loadWebhooks } from "./runtime/webhooks_loader.ts";
import { loadSensors } from "./runtime/sensors_loader.ts";
import { McpSensorRunner } from "./runtime/mcp_sensor.ts";

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

  // Behavioural knobs (wake_mode, extract_entities, max_tools_per_tick,
  // pii_mask, note_require_signed) resolve from coworkers/<name>/config.json
  // first, then env fallback, then schema defaults. Env-fallback hits emit
  // a one-time deprecation warning. See docs/adr/0007-config-file-vs-env-vars.md.
  const coworkerConfig = loadCoworkerConfig(join(coworkersDir, name), coworkerEnv, {
    warn: (m) => process.stderr.write(`${m}\n`),
  });
  // Reflect resolved config back into the env overlay so downstream code
  // paths (tick.ts, inbox.ts, wake_mode.parseWakeMode) read the effective
  // value regardless of whether the source was config.json or env.
  coworkerEnv.WAKE_MODE = coworkerConfig.wake_mode;
  coworkerEnv.EXTRACT_ENTITIES = coworkerConfig.extract_entities ? "1" : "";
  coworkerEnv.MAX_TOOLS_PER_TICK = String(coworkerConfig.max_tools_per_tick);
  coworkerEnv.PII_MASK = coworkerConfig.pii_mask ? "1" : "";
  coworkerEnv.NOTE_REQUIRE_SIGNED = coworkerConfig.note_require_signed ? "1" : "";
  // AIC-131 — trust ladder for MEMORY.md promotions; read by the reflect
  // ritual dispatch in tick.ts.
  coworkerEnv.MEMORY_PROMOTIONS = coworkerConfig.memory_promotions;
  // A few call sites still read process.env directly (inbox.ts, tick.ts).
  // Mirror the config-resolved value there so config.json actually takes
  // effect for those paths without a wider refactor.
  process.env.MAX_TOOLS_PER_TICK = String(coworkerConfig.max_tools_per_tick);
  if (coworkerConfig.note_require_signed) process.env.NOTE_REQUIRE_SIGNED = "1";
  else delete process.env.NOTE_REQUIRE_SIGNED;

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
  for (const t of memoryTools) tools.register(t);
  for (const t of githubTools) tools.register(t);
  for (const t of slackTools) tools.register(t);
  for (const t of askTools) tools.register(t);
  for (const t of roleTools) tools.register(t);
  for (const t of codeDelegateTools) tools.register(t);
  for (const t of branchRoomTools) tools.register(t);
  for (const t of gmailTools) tools.register(t);
  for (const t of memWalkTools) tools.register(t);

  // Optional MCP servers via MCP_SERVERS env var.
  const mcpConnections: McpConnection[] = [];
  const mcpClients = new Map<string, { callTool: (name: string, args?: unknown) => Promise<unknown> }>();
  for (const serverCfg of parseMcpEnv(coworkerEnv)) {
    try {
      const conn = await connectMcp(serverCfg, hygiene, stateDir, name);
      for (const t of conn.tools) tools.register(t);
      mcpConnections.push(conn);
      mcpClients.set(serverCfg.name, {
        callTool: async (toolName: string, args?: unknown) =>
          conn.client.callTool({ name: toolName, arguments: (args as Record<string, unknown>) ?? {} }),
      });
      log.stream(`mcp: connected ${serverCfg.name} (${conn.tools.length} tools)`);
    } catch (err) {
      log.stream(`mcp: failed to connect ${serverCfg.name}: ${err}`);
    }
  }

  // Declarative MCP sensors — role/SENSORS.json turns "poll an MCP tool
  // periodically, cache, diff, invalidate on webhook" into config.
  const sensorsResult = loadSensors(join(coworkersDir, name, "role"));
  for (const err of sensorsResult.errors) log.stream(`sensors: error — ${err}`);
  for (const warn of sensorsResult.warnings) log.stream(`sensors: warning — ${warn}`);
  const mcpSensorRunner = sensorsResult.specs.length > 0
    ? new McpSensorRunner({ specs: sensorsResult.specs, mcpClients })
    : undefined;
  if (mcpSensorRunner) log.stream(`mcp sensors: ${sensorsResult.specs.length} declared`);

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
  // Entity evaluator (opt-in via EXTRACT_ENTITIES=1). Prefers the cheap
  // TRIAGE_MODEL if set; falls back to COWORKER_MODEL. Never invents a
  // new required env var — see docs/adr/0006-filesystem-first-storage.md.
  const evaluatorLlm = coworkerEnv.EXTRACT_ENTITIES === "1"
    ? {
        baseUrl: coworkerEnv.OLLAMA_HOST ?? "https://ollama.com",
        apiKey: coworkerEnv.OLLAMA_API_KEY,
        model: coworkerEnv.TRIAGE_MODEL ?? llm.model,
      }
    : undefined;

  // AIC — impossible-to-miss LIVE/DRY-RUN banner. Emitted before the
  // usual start line so operators (and tailing agents) see the mode first.
  // Also sets the terminal title so a glance at the tab confirms mode.
  try { process.stdout.write(terminalTitleEscape(name, live)); } catch { /* noop */ }
  for (const line of renderModeBanner(name, live).split("\n")) log.stream(line);
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

  // WAKE_MODE decides whether the periodic tick loop runs, the wake HTTP
  // server runs, or both (default). Parsed once at startup.
  const wakeModeParsed = parseWakeMode(coworkerEnv.WAKE_MODE);
  if (wakeModeParsed.warning) log.stream(wakeModeParsed.warning);
  const wakeMode = wakeModeParsed.mode;
  log.stream(`wake_mode=${wakeMode}`);

  // In webhook-only mode we take the "very-long-sleep" shortcut instead of
  // rewriting the scheduler: base interval is pinned to 24h so the loop
  // only fires on wake events (webhooks / /wake). Consequence: rituals and
  // promises will only fire when a wake event triggers a tick that finds
  // them due — acceptable for a coworker whose activity is genuinely
  // event-driven, but do NOT choose webhook mode for anything whose
  // liveness depends on scheduled rituals firing on time. Use "both" for
  // that safety net.
  const webhookOnlyIdleMs = 24 * 60 * 60_000;
  const baseIntervalMs = wakeMode === "webhook"
    ? webhookOnlyIdleMs
    : Number(coworkerEnv.TICK_INTERVAL_MS ?? 5 * 60_000);
  const maxIntervalMs = wakeMode === "webhook"
    ? webhookOnlyIdleMs
    : (role.cadence === "constant"
        ? baseIntervalMs                       // no backoff when role is "constant"
        : Number(coworkerEnv.MAX_TICK_INTERVAL_MS ?? 30 * 60_000));
  let intervalMs = baseIntervalMs;
  let consecutiveQuiet = 0;
  const stop = { flag: false };
  const wake = { flag: false };            // event-driven wake trigger

  // Optional work_hours support — see src/runtime/work_hours.ts. If unset,
  // the coworker runs 24/7 (unchanged). If set, out-of-hours cadence is
  // adjusted per `out_of_hours` mode; webhooks/rituals/promises are
  // unaffected. `lastInHours` tracks boundary crossings so we emit a
  // work_hours.transition event exactly once per crossing.
  const workHours = coworkerConfig.work_hours;
  let lastInHours: boolean | null = null;
  if (workHours) log.stream(`work_hours: ${describeHours(workHours)}`);
  // Dead-time combination: with wake_mode=tick there is no wake HTTP server,
  // and with out_of_hours=webhook_only the periodic tick is disabled
  // out-of-hours. Together they leave the coworker with no wake source
  // out-of-hours at all — rituals and promises will queue until the next
  // in-hours tick. See AGENTS.md work_hours section.
  if (workHours && wakeMode === "tick" && workHours.out_of_hours === "webhook_only") {
    log.stream(`[WARNING] wake_mode=tick + work_hours.out_of_hours=webhook_only — coworker has no out-of-hours wake source; rituals and promises will not fire on time. Consider wake_mode=both.`);
  }

  // Optional HTTP /wake endpoint (WAKE_PORT env). Lets Linear/Slack/GitHub
  // webhooks (or any curl) fire an immediate tick.
  const wakePort = Number(coworkerEnv.WAKE_PORT ?? 0);
  const webhooksResult = loadWebhooks(join(coworkersDir, name, "role"));
  for (const err of webhooksResult.errors) log.stream(`webhooks: error — ${err}`);
  for (const warn of webhooksResult.warnings) log.stream(`webhooks: warning — ${warn}`);
  if (wakeMode === "webhook" && wakePort <= 0) {
    log.stream(`WARN wake_mode=webhook but WAKE_PORT unset — nothing will wake this coworker`);
  }
  if (wakePort > 0 && wakeMode !== "tick") {
    startWakeServer(wakePort, wake, {
      secret: coworkerEnv.WAKE_SECRET,
      events,
      coworkerName: name,
      metricsEnabled: coworkerEnv.METRICS_ENABLED === "1",
      webhooks: webhooksResult.specs,
      env: coworkerEnv,
      ...(mcpSensorRunner ? { onSensorInvalidate: (n: string) => mcpSensorRunner.invalidate(n) } : {}),
    });
    log.stream(`wake endpoint: http://127.0.0.1:${wakePort}/wake`);
    if (coworkerEnv.METRICS_ENABLED === "1") log.stream(`metrics endpoint: http://127.0.0.1:${wakePort}/metrics`);
    if (webhooksResult.specs.length) {
      const summary = webhooksResult.specs.map((s) => `${s.name} ${s.path} ${s.auth.type}`).join(", ");
      log.stream(`${name} webhooks: [${summary}]`);
    }
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
        ...(evaluatorLlm ? { evaluatorLlm } : {}),
        forceDeliberate: forceNext,
        shouldStop: () => stop.flag,
        env: coworkerEnv,
        ...(mcpSensorRunner ? { mcpSensors: mcpSensorRunner } : {}),
      });
      forceNext = false;
    } catch (err) {
      log.event("note", { fatal: false, error: String(err) });
      log.stream(`tick error: ${err}`);
    }
    // Work-hours cadence adjustment. Recomputed each iteration so the loop
    // reacts to boundary crossings within one tick.
    const nowIn = isInHours(workHours);
    if (workHours && lastInHours !== null && lastInHours !== nowIn) {
      log.event("work_hours.transition", { in_hours: nowIn, mode: workHours.out_of_hours });
      log.stream(`work_hours: ${nowIn ? "entered" : "left"} working hours (mode=${workHours.out_of_hours})`);
    }
    lastInHours = nowIn;
    const effBase = (workHours && !nowIn && workHours.out_of_hours === "webhook_only")
      ? 24 * 60 * 60_000
      : baseIntervalMs;
    const effMax = (workHours && !nowIn && workHours.out_of_hours === "webhook_only")
      ? 24 * 60 * 60_000
      : maxIntervalMs;
    // Coworker-chosen pacing hint (bounded by env limits). Overrides the
    // adaptive quiet/reset rule when explicit — the model owns the wheel.
    const rawMinMs = Number(coworkerEnv.MIN_TICK_INTERVAL_MS ?? 15_000);
    const minMs = (workHours && !nowIn && workHours.out_of_hours === "reduced")
      ? Math.max(rawMinMs, (workHours.out_of_hours_interval_min ?? 60) * 60_000)
      : rawMinMs;
    // Clamp current intervalMs into the effective window before pace math.
    if (intervalMs > effMax) intervalMs = effMax;
    if (intervalMs < minMs) intervalMs = minMs;
    if (outcome.pace === "faster") {
      intervalMs = Math.max(minMs, Math.floor(intervalMs / 2));
      consecutiveQuiet = 0;
      log.stream(`pace=faster — next tick in ${Math.round(intervalMs / 1000)}s`);
    } else if (outcome.pace === "slower") {
      intervalMs = Math.min(effMax, intervalMs * 2);
      log.stream(`pace=slower — next tick in ${Math.round(intervalMs / 1000)}s`);
    } else if (outcome.pace === "hold") {
      log.stream(`pace=hold — next tick in ${Math.round(intervalMs / 1000)}s`);
    } else if (outcome.quiet || outcome.didNoAction) {
      // Either a quiet-skipped tick OR a tick where deliberation ran but
      // chose to do nothing → back off. Repeatedly deciding "nothing to do"
      // should not keep us spinning at base cadence.
      consecutiveQuiet++;
      intervalMs = Math.min(intervalMs * 2, effMax);
      log.stream(`idle x${consecutiveQuiet} — next tick in ${Math.round(intervalMs / 1000)}s`);
    } else if (consecutiveQuiet > 0) {
      consecutiveQuiet = 0;
      intervalMs = Math.max(minMs, Math.min(effBase, effMax));
      log.stream(`activity resumed — interval reset to ${Math.round(intervalMs / 1000)}s`);
    }
    // sleep in small slices so we exit promptly on signal OR /wake
    const wakeAt = Date.now() + intervalMs;
    while (!stop.flag && !wake.flag && Date.now() < wakeAt) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (wake.flag) {
      wake.flag = false;
      intervalMs = effBase;                // reset backoff on external wake
      consecutiveQuiet = 0;
      forceNext = true;                    // bypass quiet gate — they poked us
      log.stream(`woken by event — next tick immediately`);
    }
  }
  log.event("note", { message: "shutdown" });
  // AIC-44 — cleanly close all MCP connections (stdio subprocesses and HTTP clients) before exiting.
  for (const c of mcpConnections) await c.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
