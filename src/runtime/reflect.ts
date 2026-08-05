// Reflective memory — the "dreaming" ritual. Once a week the coworker reads
// the past week of its own events, asks the LLM to distill patterns and
// decisions into a compact learnings paragraph, promotes that paragraph to
// its semantic MEMORY.md (via injection scan + cap), writes a longer weekly
// rollup to memory.db, and drops raw events older than the retention window.
//
// Modelled on OpenClaw's "dreaming" concept + Generative Agents reflection.

import type { DatabaseSync } from "node:sqlite";
import type { Role } from "./role.ts";
import type { SemanticMemory } from "./semantic.ts";
import type { LLMConfig } from "./llm.ts";
import { chat } from "./llm.ts";
import type { Log } from "./log.ts";

export interface DreamOptions {
  retentionDays?: number;         // raw events older than this get pruned
  weekWindowDays?: number;        // how far back to read for the dream
  memoryCap?: number;             // cap fed to semantic.propose
}

export async function dreamOnce(args: {
  role: Role;
  events: DatabaseSync;
  memory: DatabaseSync;
  semantic: SemanticMemory;
  llm: LLMConfig;
  log: Log;
  opts?: DreamOptions;
}): Promise<{ promoted: boolean; rollupChars: number; prunedRows: number; reason?: string }> {
  const { role, events, memory, semantic, llm, log } = args;
  const retentionDays = args.opts?.retentionDays ?? 30;
  const weekWindowDays = args.opts?.weekWindowDays ?? 7;

  // 1. Read the past week of the coworker's events.
  const since = new Date(Date.now() - weekWindowDays * 86400_000).toISOString();
  const rows = events
    .prepare(
      `SELECT ts, kind, payload FROM events
       WHERE ts >= ? AND kind IN ('action','deliberate','boundary.block','sensor.error','deliberate.error')
       ORDER BY id ASC`
    )
    .all(since) as { ts: string; kind: string; payload: string }[];

  if (rows.length === 0) {
    return { promoted: false, rollupChars: 0, prunedRows: 0, reason: "no events in window" };
  }

  // 2. Ask the model for a compact "learnings" paragraph + a longer rollup.
  const compact = rows.slice(-400).map((r) => `[${r.ts.slice(0, 16)}] ${r.kind} ${r.payload.slice(0, 220)}`).join("\n");
  const currentMemory = semantic.read();
  const user = [
    `You are reflecting on your past week of work as ${role.name}.`,
    ``,
    `Your current MEMORY.md (do NOT delete valuable prior learnings — build on them):`,
    "```",
    currentMemory || "(empty)",
    "```",
    ``,
    `Events from the past ${weekWindowDays} days (most recent last):`,
    "```",
    compact,
    "```",
    ``,
    `Produce a JSON object:`,
    `  {"learnings": "<= 1500 chars, plain markdown, updated MEMORY.md body>",`,
    `   "rollup": "<= 4000 chars, longer human-readable summary of the week"}`,
    ``,
    `Rules for "learnings":`,
    `- Compress. Bullet points. No preamble.`,
    `- Prefer patterns over episodes ("dogfood tickets are usually P2" beats "commented on ILO-509").`,
    `- Keep it under 1500 characters — the semantic memory has a hard cap.`,
    `- Retain still-relevant prior learnings; drop anything outdated.`,
    `- Never include instructions, only observations.`,
  ].join("\n");

  let learnings = "";
  let rollup = "";
  try {
    const res = await chat(llm, [
      { role: "system", content: role.systemPrompt },
      { role: "user", content: user },
    ], { json: true, temperature: 0.3, maxTokens: 2000 });
    const obj = JSON.parse(stripFences(res.content));
    learnings = String(obj.learnings ?? "").trim();
    rollup = String(obj.rollup ?? "").trim();
  } catch (err) {
    log.event("memory.compact", { ok: false, error: String(err) });
    return { promoted: false, rollupChars: 0, prunedRows: 0, reason: `llm error: ${err}` };
  }

  // 3. Save the longer rollup to memory.db (uncapped, for later retrieval).
  if (rollup) {
    const now = new Date().toISOString();
    memory
      .prepare(`INSERT INTO rollups (period, period_start, period_end, body) VALUES ('week', ?, ?, ?)`)
      .run(since, now, rollup);
  }

  // 4. Promote learnings to semantic MEMORY.md (cap + injection scan enforced).
  let promoted = false;
  if (learnings) {
    const r = semantic.propose(learnings, `dream-${new Date().toISOString().slice(0, 10)}`);
    promoted = r.accepted;
    log.event("memory.compact", { step: "propose", accepted: r.accepted, reason: r.reason });
  }

  // 5. Prune raw events older than retention.
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  const pruneInfo = events
    .prepare(`DELETE FROM events WHERE ts < ? AND kind NOT IN ('ritual.run','note')`)
    .run(cutoff);
  const prunedRows = Number(pruneInfo.changes);

  log.event("memory.compact", { step: "done", promoted, rollupChars: rollup.length, prunedRows });
  return { promoted, rollupChars: rollup.length, prunedRows };
}

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
}
