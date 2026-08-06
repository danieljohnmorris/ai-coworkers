// One deliberation turn. Given the role, current perception (sensor output),
// recent action log, and pending promises, ask the model whether to act.
// Returns either { action: "noop", reason } or { action: "call", tool, input, reason }.

import type { Role } from "./role.ts";
import { chat, type LLMConfig } from "./llm.ts";
import type { ToolDef } from "./tools.ts";
import type { TempoSnapshot, BudgetSnapshot } from "./tempo.ts";
import { cfg, truncated } from "./config.ts";

export interface Perception {
  now: string;
  sensors: { name: string; result: unknown; error?: string }[];
  recentActions: { ts: string; tool: string; input: unknown; outcome: string }[];
  pendingPromises: { id: number; trigger: string; action: string; fire_after: string | null }[];
  resources: { kind: string; count: number }[];
  rollups: { period: string; body: string }[];
  tempo: TempoSnapshot;
  budget: BudgetSnapshot;
  tempoGuidance: string;         // extracted from RITUALS.md "Tempo" section
  highlightsTail: string;         // condensed narrative of recent notable events
  recentThoughts: string;         // your last few thoughts-to-self, in order
  inboxUnread: string;             // messages from your manager (human) since last read
  reactionsUnread: string;         // 👍 / 👎 reactions from your manager since last read
}

export type Pace = "faster" | "hold" | "slower";

export type Decision =
  | { action: "noop"; reason: string; thoughts?: string; pace?: Pace }
  | { action: "call"; tool: string; input: unknown; reason: string; thoughts?: string; pace?: Pace };

export interface PriorStep {
  tool: string;
  input: unknown;
  outcome: unknown;
}

export async function deliberate(
  role: Role,
  perception: Perception,
  actions: ToolDef[],
  llm: LLMConfig,
  priorSteps: PriorStep[] = [],
): Promise<Decision> {
  const toolCatalog = actions.map((a) => ({
    name: a.name,
    description: a.description,
    inputSchema: a.inputSchema,
  }));

  const userMsg = [
    `# Now`,
    perception.now,
    ``,
    `# Your tempo (observed)`,
    `actions_last_1h: ${perception.tempo.actionsLast1h}`,
    `actions_last_24h: ${perception.tempo.actionsLast24h}`,
    `noop_ratio_last_100_ticks: ${perception.tempo.noopRatioLast100Ticks}`,
    `seconds_since_last_action: ${perception.tempo.secondsSinceLastAction ?? "never"}`,
    `seconds_since_perception_changed: ${perception.tempo.secondsSinceLastPerceptionChange ?? "unknown"}`,
    `llm_calls_today: ${perception.budget.llmCallsToday}`,
    // Rolling window (matches provider quota — Ollama Cloud resets every 5h)
    `llm_calls_in_${(perception.budget as any).windowMinutes ?? 300}min_window: ${(perception.budget as any).callsInWindow ?? 0} / ${(perception.budget as any).windowCap ?? "?"} (${(perception.budget as any).pctWindowUsed ?? 0}% used)`,
    ``,
    `# Your expected tempo (from RITUALS.md)`,
    perception.tempoGuidance || "(no explicit tempo section in RITUALS.md — infer from responsibilities)",
    ``,
    `# Sensors (what's happening in the world)`,
    JSON.stringify(perception.sensors, null, 2),
    ``,
    `# Your recent notable events (highlights — condensed)`,
    perception.highlightsTail || "(nothing recent)",
    ``,
    `# Your pending promises`,
    JSON.stringify(perception.pendingPromises, null, 2),
    ``,
    `# Your resource usage`,
    JSON.stringify(perception.resources, null, 2),
    ``,
    `# Recent memory rollups`,
    JSON.stringify(perception.rollups, null, 2),
    ``,
    `# Available actions`,
    JSON.stringify(toolCatalog, null, 2),
    ``,
    perception.inboxUnread
      ? `# 📬 UNREAD NOTES FROM YOUR MANAGER (read and consider FIRST — these override recent inferences)\n\n${perception.inboxUnread}`
      : ``,
    perception.inboxUnread ? `` : ``,
    perception.reactionsUnread
      ? `# 🫱 UNREAD REACTIONS FROM YOUR MANAGER (👍 = keep doing this; 👎 = stop / correct course)\n\n${perception.reactionsUnread}`
      : ``,
    perception.reactionsUnread ? `` : ``,
    `# Your recent thoughts to yourself`,
    perception.recentThoughts || "(no recent thoughts logged)",
    ``,
    priorSteps.length ? `# Steps you have taken in THIS tick (chained tool calls so far)` : ``,
    priorSteps.length
      ? priorSteps.map((s, i) =>
          // 4000 chars is enough for a full team_labels payload or issue detail
          // without wrecking the prompt budget. Bump if you routinely see the
          // model complain about "truncated" outcomes.
          `${i + 1}. ${s.tool} ${truncated(JSON.stringify(s.input), cfg.priorStepInputMaxChars)}\n   → ${truncated(JSON.stringify(s.outcome), cfg.priorStepOutcomeMaxChars)}`
        ).join("\n")
      : ``,
    priorSteps.length ? `` : ``,
    `# Task`,
    `Given your role, responsibilities, authority, boundaries, rituals, AND`,
    `the tempo section above, decide whether to take ONE action this tick`,
    `or do nothing.`,
    ``,
    `Rhythm matters. If you are acting far above your expected tempo, or if`,
    `nothing has meaningfully changed since your last action, prefer noop.`,
    `A well-paced coworker is more valuable than a busy one.`,
    ``,
    priorSteps.length
      ? `You are ALREADY mid-task within this tick. You may chain another tool call to continue, or noop with reason "done" to end the tick. NEVER call the same (tool, input) pair twice in one tick — if it succeeded, move on; if it failed, try a genuinely different approach or bail.`
      : `You may start a chain — if you take an action, you can call further tools this same tick based on results. Do so only when the steps genuinely belong together (e.g. detail → team_labels → set_labels for one issue).`,
    ``,
    `**Do not thrash on the same ticket.** Your recent thoughts + highlights show what you have already handled. If you labelled an issue in the last few ticks, DO NOT re-open it — pick a different untagged issue from the sensor. A single sanity re-check is fine, and it IS worth re-reading an issue you previously handled IF its updatedAt is newer than when you last touched it (the reporter may have edited or replied). Otherwise, move on. If nothing new needs doing on the backlog, noop with reason "backlog quiet".`,
    ``,
    `Also, keep a running notebook to yourself. Include a "thoughts" field —`,
    `short, private, working-notes-to-future-self. This is NOT for the reason`,
    `field (which is public and terse); it's the ongoing internal monologue`,
    `that lets you continue trains of thought across ticks. Reference and`,
    `build on your earlier thoughts above where relevant.`,
    ``,
    `You may also include an optional "pace" field to hint how soon you should tick again:`,
    `  "faster" — halve the next interval (use when actively working, budget healthy)`,
    `  "hold"   — keep the current interval`,
    `  "slower" — double the next interval (use when idle, or approaching a budget limit)`,
    `The runtime clamps your choice to safe bounds and falls back to adaptive backoff if omitted. Use it especially to conserve LLM budget as you approach the window cap.`,
    ``,
    `Respond with a single JSON object, no prose, no code fences, matching one of:`,
    `  {"thoughts":"...","action":"noop","reason":"...","pace":"slower"}`,
    `  {"thoughts":"...","action":"call","tool":"<name>","input":{...},"reason":"...","pace":"faster"}`,
  ].join("\n");

  const res = await chat(
    llm,
    [
      { role: "system", content: role.systemPrompt },
      { role: "user", content: userMsg },
    ],
    { json: true, temperature: 0.2, maxTokens: 800 }
  );

  const decision = parseDecision(res.content);
  // AIC-45 — attach token usage so the tick can log it.
  (decision as any).usage = res.usage;
  return decision;
}

export function parseDecision(raw: string): Decision & { rawOutput?: string } {
  const text = raw.trim();
  // Try direct parse first, then extract the first {...} block if the model
  // wrapped it in prose or a code fence.
  const attempts = [
    text,
    text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim(),
    extractFirstJsonObject(text),
  ].filter(Boolean) as string[];

  for (const candidate of attempts) {
    try {
      const obj = JSON.parse(candidate);
      const thoughts = typeof obj.thoughts === "string" ? obj.thoughts : undefined;
      const pace = (["faster", "hold", "slower"] as const).includes(obj.pace) ? obj.pace as Pace : undefined;
      if (obj.action === "noop") return { action: "noop", reason: String(obj.reason ?? ""), thoughts, pace };
      // Explicit call form
      if (obj.action === "call" && obj.tool) {
        return {
          action: "call",
          tool: String(obj.tool),
          input: obj.input ?? {},
          reason: String(obj.reason ?? ""),
          thoughts,
          pace,
        };
      }
      // Lenient forms models often produce:
      //   { action: "<toolname>", input: {...} }
      //   { tool: "<toolname>", input: {...} }
      const toolName = typeof obj.tool === "string" ? obj.tool
        : (typeof obj.action === "string" && obj.action !== "noop" && obj.action.includes(".")) ? obj.action
        : null;
      if (toolName) {
        return {
          action: "call",
          tool: toolName,
          input: obj.input ?? obj.arguments ?? obj.args ?? {},
          reason: String(obj.reason ?? ""),
          thoughts,
          pace,
        };
      }
    } catch {
      // try next candidate
    }
  }
  return {
    action: "noop",
    reason: `unparseable model output`,
    rawOutput: raw,
  };
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
    } else {
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
  }
  return null;
}
