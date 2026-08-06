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
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
      `SELECT id, ts, kind, payload FROM events
       WHERE ts >= ? AND kind IN ('action','deliberate','boundary.block','sensor.error','deliberate.error')
       ORDER BY id ASC`
    )
    .all(since) as { id: number; ts: string; kind: string; payload: string }[];

  if (rows.length === 0) {
    return { promoted: false, rollupChars: 0, prunedRows: 0, reason: "no events in window" };
  }

  // 2. Ask the model for a compact "learnings" paragraph + a longer rollup.
  // Include the event id in each line so the model can cite specific events
  // as evidence for its claims (AIC-70) — makes learnings traceable, not vibes.
  const compact = rows.slice(-400).map((r) => `[ev:${r.id} ${r.ts.slice(0, 16)}] ${r.kind} ${r.payload.slice(0, 220)}`).join("\n");
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
    `- Cite the events that support each non-trivial claim, using the [ev:id,id,...] markers`,
    `  from the input above. Example: "- Dogfood tickets tend to be P2 [ev:1234,1289,1301]".`,
    `  Cite at most 3 events per claim; skip citations for meta-notes that don't reference specific work.`,
    `- If you carry forward a prior learning from MEMORY.md, keep its existing [ev:...] marker verbatim.`,
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

  // 4. Promote learnings to semantic MEMORY.md — with AIC-38 promotion gate,
  // AIC-39 version snapshot + 25% loss guard, AIC-40 Dream Diary append.
  let promoted = false;
  const priorBody = semantic.read();
  if (learnings) {
    const dreamId = `dream-${new Date().toISOString().slice(0, 10)}`;

    // AIC-38 gate — reject learnings that contain no reference to any entity
    // or ticket identifier seen in the events window. Cheap sanity check
    // against LLM-hallucinated "learnings".
    const seenIdentifiers = new Set(
      rows.flatMap((r) => (r.payload.match(/\b[A-Z]{2,4}-\d+\b/g) ?? []))
    );
    const learningsMentionKnownIds = seenIdentifiers.size === 0
      || [...seenIdentifiers].some((id) => learnings.includes(id))
      || /\b(pattern|noticed|tends? to|usually|always|never)\b/i.test(learnings);
    if (!learningsMentionKnownIds) {
      log.event("memory.compact", { step: "gate.reject", reason: "no reference to recent events / no pattern language" });
    } else {
      // AIC-39 — 25% loss guard: if the new body drops >25% chars vs prior,
      // require operator confirmation via a persisted question, do not
      // overwrite in place.
      const priorLen = priorBody.length;
      const lossPct = priorLen === 0 ? 0 : Math.max(0, (priorLen - learnings.length) / priorLen);
      if (lossPct > 0.25) {
        log.event("memory.compact", { step: "loss_guard", reason: `would remove ${Math.round(lossPct * 100)}% of prior memory — kept prior, logged candidate` });
        appendDreamDiary(args, dreamId, {
          added: [], dropped: [],
          note: `LOSS-GUARD blocked promotion (${Math.round(lossPct * 100)}% shrink). Candidate saved to memory_versions; run bin/memory-rollback.sh to review.`,
        });
        saveVersion(memory, dreamId + "-candidate", learnings);
      } else {
        // AIC-60 — snapshot + propose must be atomic to avoid split-brain
        // (before-snapshot saved but new memory never written on crash).
        memory.exec("BEGIN");
        let r: { accepted: boolean; reason: string };
        try {
          saveVersion(memory, dreamId + "-before", priorBody);
          r = semantic.propose(learnings, dreamId);
          if (!r.accepted) throw new Error(`semantic rejected: ${r.reason}`);
          memory.exec("COMMIT");
          promoted = true;
        } catch (err) {
          memory.exec("ROLLBACK");
          promoted = false;
          r = { accepted: false, reason: String(err) };
        }
        log.event("memory.compact", { step: "propose", accepted: promoted, reason: r.reason });
        if (promoted) {
          appendDreamDiary(args, dreamId, {
            added: diffBullets(priorBody, learnings),
            dropped: diffBullets(learnings, priorBody),
            note: `promoted (${learnings.length} chars; rollup ${rollup.length} chars)`,
          });
        }
      }
    }
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

// --- AIC-39 memory_versions table (rollback support) ---
function saveVersion(memory: DatabaseSync, tag: string, body: string): void {
  memory.exec(`
    CREATE TABLE IF NOT EXISTS memory_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL, tag TEXT NOT NULL, body TEXT NOT NULL
    );
  `);
  memory.prepare(`INSERT INTO memory_versions (ts, tag, body) VALUES (?, ?, ?)`)
    .run(new Date().toISOString(), tag, body);
}

// --- AIC-40 DREAMS.md diary ---
function appendDreamDiary(
  args: { role: { dir: string; name: string } },
  dreamId: string,
  entry: { added: string[]; dropped: string[]; note: string }
): void {
  const path = args.role.dir + "/../state/memory/DREAMS.md";
  const block = [
    `## ${dreamId}`,
    entry.added.length ? `**Added:**\n${entry.added.map((s) => "- " + s).join("\n")}` : "",
    entry.dropped.length ? `**Dropped:**\n${entry.dropped.map((s) => "- " + s).join("\n")}` : "",
    entry.note ? `_${entry.note}_` : "",
    "",
  ].filter(Boolean).join("\n") + "\n";
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, block);
  } catch {
    // best-effort — diary is diagnostic, not load-bearing
  }
}

// Bullet-line set diff for the DREAMS.md summary. Not exhaustive but useful.
function diffBullets(a: string, b: string): string[] {
  const asLines = (s: string) => new Set(
    s.split(/\r?\n/).map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean)
  );
  const aa = asLines(a), bb = asLines(b);
  return [...bb].filter((l) => !aa.has(l)).slice(0, 20);
}

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
}
