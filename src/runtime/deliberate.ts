// One deliberation turn. Given the role, current perception (sensor output),
// recent action log, and pending promises, ask the model whether to act.
// Returns either { action: "noop", reason } or { action: "call", tool, input, reason }.

import type { Role } from "./role.ts";
import { chat, type LLMConfig } from "./llm.ts";
import type { ToolDef } from "./tools.ts";

export interface Perception {
  now: string;
  sensors: { name: string; result: unknown; error?: string }[];
  recentActions: { ts: string; tool: string; input: unknown; outcome: string }[];
  pendingPromises: { id: number; trigger: string; action: string; fire_after: string | null }[];
  resources: { kind: string; count: number }[];
  rollups: { period: string; body: string }[];
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
    `# Sensors (what's happening in the world)`,
    JSON.stringify(perception.sensors, null, 2),
    ``,
    `# Your recent actions`,
    JSON.stringify(perception.recentActions.slice(-10), null, 2),
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
    `Given your role, responsibilities, authority, boundaries, and rituals,`,
    `decide whether to take ONE action this tick, or do nothing.`,
    `Doing nothing is often correct — do not act just because you can.`,
    ``,
    `Respond with a single JSON object, no prose, matching one of:`,
    `  { "action": "noop", "reason": "..." }`,
    `  { "action": "call", "tool": "<name>", "input": {...}, "reason": "..." }`,
  ].join("\n");

  const res = await chat(
    llm,
    [
      { role: "system", content: role.systemPrompt },
      { role: "user", content: userMsg },
    ],
    { json: true, temperature: 0.2 }
  );

  return parseDecision(res.content);
}

function parseDecision(raw: string): Decision {
  const text = raw.trim();
  // Strip fenced code if the model wrapped it
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    const obj = JSON.parse(stripped);
    if (obj.action === "noop") return { action: "noop", reason: String(obj.reason ?? "") };
    if (obj.action === "call")
      return {
        action: "call",
        tool: String(obj.tool),
        input: obj.input ?? {},
        reason: String(obj.reason ?? ""),
      };
  } catch {
    // fall through
  }
  return { action: "noop", reason: `unparseable model output: ${text.slice(0, 200)}` };
}
