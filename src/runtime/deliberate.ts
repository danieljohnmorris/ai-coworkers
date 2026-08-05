// One deliberation turn. Given the role, current perception (sensor output),
// recent action log, and pending promises, ask the model whether to act.
// Returns either { action: "noop", reason } or { action: "call", tool, input, reason }.

import type { Role } from "./role.ts";
import { chat, type LLMConfig } from "./llm.ts";
import type { ToolDef } from "./tools.ts";
import type { TempoSnapshot, BudgetSnapshot } from "./tempo.ts";

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
}

export type Decision =
  | { action: "noop"; reason: string }
  | { action: "call"; tool: string; input: unknown; reason: string };

export async function deliberate(
  role: Role,
  perception: Perception,
  actions: ToolDef[],
  llm: LLMConfig
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
    `# Task`,
    `Given your role, responsibilities, authority, boundaries, rituals, AND`,
    `the tempo section above, decide whether to take ONE action this tick`,
    `or do nothing.`,
    ``,
    `Rhythm matters. If you are acting far above your expected tempo, or if`,
    `nothing has meaningfully changed since your last action, prefer noop.`,
    `A well-paced coworker is more valuable than a busy one.`,
    ``,
    `Respond with a single JSON object, no prose, no code fences, matching one of:`,
    `  {"action":"noop","reason":"..."}`,
    `  {"action":"call","tool":"<name>","input":{...},"reason":"..."}`,
  ].join("\n");

  const res = await chat(
    llm,
    [
      { role: "system", content: role.systemPrompt },
      { role: "user", content: userMsg },
    ],
    { json: true, temperature: 0.2, maxTokens: 800 }
  );

  return parseDecision(res.content);
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
      if (obj.action === "noop") return { action: "noop", reason: String(obj.reason ?? "") };
      // Explicit call form
      if (obj.action === "call" && obj.tool) {
        return {
          action: "call",
          tool: String(obj.tool),
          input: obj.input ?? {},
          reason: String(obj.reason ?? ""),
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
