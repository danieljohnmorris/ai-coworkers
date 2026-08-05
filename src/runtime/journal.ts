// Daily journal ritual. Once a day, the coworker writes a short human-readable
// markdown reflection of the day's work to state/journal/YYYY-MM-DD.md.
// Different from the reflective ritual: journal is a chronological narrative
// for humans; the reflective ritual updates semantic MEMORY.md for the model.

import type { DatabaseSync } from "node:sqlite";
import type { LLMConfig } from "./llm.ts";
import type { Log } from "./log.ts";
import type { Role } from "./role.ts";
import { chat } from "./llm.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export async function writeJournal(args: {
  role: Role;
  events: DatabaseSync;
  journalDir: string;
  llm: LLMConfig;
  log: Log;
}): Promise<{ path: string; chars: number }> {
  const { role, events, journalDir, llm, log } = args;
  mkdirSync(journalDir, { recursive: true });

  // Yesterday's events (UTC day)
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const dayStart = yesterday.toISOString();
  const dayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const rows = events
    .prepare(
      `SELECT ts, kind, payload FROM events
       WHERE ts >= ? AND ts < ? AND kind IN ('action','boundary.block','deliberate','sensor.error')
       ORDER BY id ASC`
    )
    .all(dayStart, dayEnd) as { ts: string; kind: string; payload: string }[];

  const dayLabel = yesterday.toISOString().slice(0, 10);
  const path = join(journalDir, `${dayLabel}.md`);

  if (rows.length === 0) {
    const body = `# ${dayLabel} — ${role.name}\n\nQuiet day. No actions or notable events.\n`;
    writeFileSync(path, body);
    return { path, chars: body.length };
  }

  const compact = rows.slice(-300).map((r) => `[${r.ts.slice(11,16)}] ${r.kind} ${r.payload.slice(0,200)}`).join("\n");
  const prompt = [
    `You are ${role.name}. Write a short journal entry for ${dayLabel} in your own voice.`,
    `Cover: what you did, patterns you noticed, unresolved threads, anything worth flagging.`,
    `Do NOT list every event — synthesise. Under 500 words. Plain markdown, no code fences.`,
    ``,
    `Events (chronological):`,
    "```",
    compact,
    "```",
  ].join("\n");

  let body = `# ${dayLabel} — ${role.name}\n\n(entry generation failed)`;
  try {
    const res = await chat(llm, [
      { role: "system", content: role.systemPrompt },
      { role: "user", content: prompt },
    ], { temperature: 0.4, maxTokens: 900 });
    body = `# ${dayLabel} — ${role.name}\n\n${res.content.trim()}\n`;
  } catch (err) {
    log.event("note", { journal: dayLabel, error: String(err) });
  }
  writeFileSync(path, body);
  return { path, chars: body.length };
}
