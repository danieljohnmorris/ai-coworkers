// Reflective memory — the "dreaming" ritual. Once a week the coworker reads
// the past week of its own events, asks the LLM to distill patterns and
// decisions into a compact learnings paragraph, promotes that paragraph to
// its semantic MEMORY.md (via injection scan + cap), writes a longer weekly
// rollup to memory.db, and moves raw events older than the retention window
// into the events_archive cold table (AIC-127).
//
// AIC-131 adds the review inbox around the promotion path: promotions the
// ritual trusts apply immediately ("applied" in the dream diary); the rest
// queue as `-candidate` memory_versions rows ("queued" — the diary IS the
// inbox). state/memory-map.md projects the ladder + the queue for the owner
// (writeMemoryMap), `approvePendingPromotion` / `strikeMemoryBullets` are
// the owner's `bin/aicw memory-approve` / `memory-strike` levers, and the
// rollup input excludes retrieval-output events so remembered material is
// never summarised as fresh experience (rollupInputRows, ADR-0008).
//
// Modelled on OpenClaw's "dreaming" concept + Generative Agents reflection.

import type { DatabaseSync } from "node:sqlite";
import type { Role } from "./role.ts";
import type { SemanticMemory } from "./semantic.ts";
import type { LLMConfig } from "./llm.ts";
import { chat } from "./llm.ts";
import type { Log } from "./log.ts";
import { eventIdsResolve } from "./memory.ts";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DreamOptions {
  retentionDays?: number;         // raw events older than this get pruned
  weekWindowDays?: number;        // how far back to read for the dream
  memoryCap?: number;             // cap fed to semantic.propose
  // AIC-131 trust ladder: "confident" (default — the ritual applies
  // low-loss promotions itself, exactly the pre-AIC-131 behaviour) or
  // "gated" (every promotion queues as a -candidate for the owner to
  // approve via bin/aicw memory-approve; MEMORY.md is never touched
  // in-ritual). Wired from the memory_promotions config knob.
  memoryPromotions?: "confident" | "gated";
}

export async function dreamOnce(args: {
  role: Role;
  events: DatabaseSync;
  memory: DatabaseSync;
  semantic: SemanticMemory;
  llm: LLMConfig;
  log: Log;
  opts?: DreamOptions;
}): Promise<{ promoted: boolean; queued: boolean; rollupChars: number; prunedRows: number; archivedRows: number; reason?: string }> {
  const { role, events, memory, semantic, llm, log } = args;
  const retentionDays = args.opts?.retentionDays ?? 30;
  const weekWindowDays = args.opts?.weekWindowDays ?? 7;

  // 1. Read the past week of the coworker's events. rollupInputRows applies
  // the AIC-131 compaction-exclusion invariant (see its comment): retrieval
  // OUTPUT never feeds the summariser, only lived events do.
  const since = new Date(Date.now() - weekWindowDays * 86400_000).toISOString();
  const rows = rollupInputRows(events, since);

  if (rows.length === 0) {
    writeMemoryMap(memory, args);
    return { promoted: false, queued: false, rollupChars: 0, prunedRows: 0, archivedRows: 0, reason: "no events in window" };
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
    writeMemoryMap(memory, args);
    return { promoted: false, queued: false, rollupChars: 0, prunedRows: 0, archivedRows: 0, reason: `llm error: ${err}` };
  }

  // 3. Save the longer rollup to memory.db (uncapped, for later retrieval).
  // AIC-128: the weekly rollup is rung 2 of the memory ladder — it records
  // its level and the raw-event id span it distilled, then adopts any
  // day-level rollups (level 1) whose period falls inside this week. A span
  // that does not resolve against events/events_archive is written as NULL
  // and logged — bad provenance is worse than none (ADR-0008).
  if (rollup) {
    const now = new Date().toISOString();
    const firstId = rows[0].id;
    const lastId = rows[rows.length - 1].id;
    let sourceRange: string | null = null;
    if (eventIdsResolve(events, [firstId, lastId])) {
      sourceRange = JSON.stringify([firstId, lastId]);
    } else {
      log.event("memory.compact", {
        step: "provenance", ok: false,
        reason: `rollup source range [${firstId},${lastId}] did not resolve against events/events_archive — wrote NULL`,
      });
    }
    const info = memory
      .prepare(`INSERT INTO rollups (period, period_start, period_end, body, level, source_range) VALUES ('week', ?, ?, ?, 2, ?)`)
      .run(since, now, rollup, sourceRange);
    memory
      .prepare(`UPDATE rollups SET parent_id = ? WHERE level = 1 AND parent_id IS NULL AND period_start >= ? AND period_end <= ?`)
      .run(Number(info.lastInsertRowid), since, now);
  }

  // 4. Promote learnings to semantic MEMORY.md — with AIC-38 promotion gate,
  // AIC-39 version snapshot + 25% loss guard, AIC-40 Dream Diary append,
  // and the AIC-131 confidence split: every promotion either applies
  // immediately (diary records it "applied") or queues as a `-candidate`
  // memory_versions row (diary records it "queued" — the diary IS the
  // review inbox, mirrored in memory-map.md's "Queued promotions" section).
  let promoted = false;
  let queued = false;
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
      // AIC-131 confidence split. Two roads to "queued", neither of which
      // touches MEMORY.md:
      //   1. memoryPromotions="gated" — the owner wants to approve every
      //      promotion by hand, so ALL candidates queue regardless of loss.
      //   2. confident mode + the AIC-39 25% loss guard — a high-shrink
      //      candidate is not trusted to apply itself.
      // Both save a `<dreamId>-candidate` version for bin/aicw
      // memory-approve to apply later.
      const gated = (args.opts?.memoryPromotions ?? "confident") === "gated";
      const priorLen = priorBody.length;
      const lossPct = priorLen === 0 ? 0 : Math.max(0, (priorLen - learnings.length) / priorLen);
      if (gated || lossPct > 0.25) {
        const why = gated
          ? `gated mode — memoryPromotions="gated" queues every promotion for owner approval`
          : `LOSS-GUARD blocked promotion (${Math.round(lossPct * 100)}% shrink)`;
        log.event("memory.compact", { step: gated ? "promotion.queued" : "loss_guard", reason: why });
        saveVersion(memory, dreamId + "-candidate", learnings);
        queued = true;
        appendDreamDiary(args, dreamId, {
          added: [], dropped: [],
          note: `QUEUED — ${why}. Candidate saved as ${dreamId}-candidate; run bin/aicw memory-approve ${role.name} to apply.`,
        });
      } else {
        // Confident + low loss — apply immediately. AIC-60 — snapshot +
        // propose must be atomic to avoid split-brain (before-snapshot
        // saved but new memory never written on crash).
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
            note: `APPLIED — promoted (${learnings.length} chars; rollup ${rollup.length} chars)`,
          });
        }
      }
    }
  }

  // 5. Prune raw events older than retention. AIC-127: archive-then-delete —
  // the retention window bounds the *hot* table only; older rows move to
  // events_archive instead of vanishing. INSERT OR IGNORE on the carried-over
  // id makes a re-run after a crash between insert and delete idempotent, and
  // the transaction keeps archive + delete atomic.
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  let prunedRows = 0;
  let archivedRows = 0;
  events.exec("BEGIN");
  try {
    const archiveInfo = events
      .prepare(
        `INSERT OR IGNORE INTO events_archive (id, ts, coworker, kind, payload)
         SELECT id, ts, coworker, kind, payload FROM events
         WHERE ts < ? AND kind NOT IN ('ritual.run','note')`
      )
      .run(cutoff);
    archivedRows = Number(archiveInfo.changes);
    const pruneInfo = events
      .prepare(`DELETE FROM events WHERE ts < ? AND kind NOT IN ('ritual.run','note')`)
      .run(cutoff);
    prunedRows = Number(pruneInfo.changes);
    events.exec("COMMIT");
  } catch (err) {
    events.exec("ROLLBACK");
    log.event("memory.compact", { step: "prune", ok: false, error: String(err) });
  }

  // Checkpoint the WAL so the events db file does not grow unboundedly
  // between backups. Harmless no-op when the db is not in WAL mode.
  try {
    events.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
  } catch (err) {
    log.event("memory.compact", { step: "wal_checkpoint", ok: false, error: String(err) });
  }

  // AIC-131 rung 1 — regenerate the ladder projection LAST, so the queued
  // section reflects any candidate this run just saved.
  writeMemoryMap(memory, args);

  log.event("memory.compact", { step: "done", promoted, queued, rollupChars: rollup.length, prunedRows, archivedRows });
  return { promoted, queued, rollupChars: rollup.length, prunedRows, archivedRows };
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

// --- AIC-131 rung 3: compaction-exclusion invariant on the rollup input ---
//
// How retrieved material becomes events: every successful tool call writes
// a kind="note" event whose payload is {tool, outcome, step} (tick.ts), and
// for the memory-retrieval tools the `outcome` IS retrieved content — FTS
// hits (memory.search), a recall paragraph (memory.recall), a ladder
// drill-down trace (memory.walk), or the notes scratchpad
// (memory.notes_read). Summarising those rows at reflect time would launder
// remembered material back into the week's rollup as if it were fresh
// experience — the compaction-exclusion failure mode Eve ships against,
// cited in the ADR-0009 harness sweep. The kind whitelist in
// rollupInputRows already excludes "note"; this filter makes the exclusion
// structural (keyed on the payload shape that carries retrieval output) so
// a future widening of the whitelist cannot silently reintroduce it.
// ADR-0008: the ladder distils lived events, never its own output.
//
// Static string-keyed membership — Record per project convention.
export const RETRIEVAL_TOOLS: Record<string, true> = {
  "memory.search": true,     // src/tools/memory.ts — FTS5 hits over the event log
  "memory.recall": true,     // src/tools/memory.ts — search + summary paragraph
  "memory.walk": true,       // src/tools/mem_walk.ts — ladder drill-down trace
  "memory.notes_read": true, // src/tools/memory.ts — freeform notes scratchpad
};

export function isRetrievalOutputEvent(row: { kind: string; payload: string }): boolean {
  if (row.kind !== "note") return false;
  try {
    const p = JSON.parse(row.payload) as { tool?: unknown };
    return typeof p.tool === "string" && RETRIEVAL_TOOLS[p.tool] === true;
  } catch {
    return false; // unparseable payload is not retrieval output
  }
}

// The events query feeding the weekly rollup body (dreamOnce step 1).
// Retrieve-once, summarise-never: rows whose payload is retrieval OUTPUT
// are dropped after the kind-filtered fetch (AIC-131, ADR-0008).
export function rollupInputRows(
  events: DatabaseSync,
  since: string
): { id: number; ts: string; kind: string; payload: string }[] {
  return (
    events
      .prepare(
        `SELECT id, ts, kind, payload FROM events
         WHERE ts >= ? AND kind IN ('action','deliberate','boundary.block','sensor.error','deliberate.error')
         ORDER BY id ASC`
      )
      .all(since) as { id: number; ts: string; kind: string; payload: string }[]
  ).filter((r) => !isRetrievalOutputEvent(r));
}

// --- AIC-131 rung 1: state/memory-map.md ladder projection ---
//
// A human-readable, level-ordered rendering of the memory ladder (months →
// weeks → days → raw events) plus the review inbox's queued promotions,
// written next to MEMORY.md in state/. READ-ONLY PROJECTION, regenerated
// (overwritten) on every ritual run and after every inbox mutation below:
// it is NEVER read by perception, deliberation, or any tool, and no code
// may source it as an input — it exists so the owner can see the ladder and
// the queue on one page. A future consumer must copy the query, not the
// file. Excerpt = first sentence of a rollup body, capped ~120 chars.

interface MapRollup {
  id: number;
  period: string;
  period_start: string;
  period_end: string;
  body: string;
  level: number | null;
  parent_id: number | null;
}

// Legacy rows written before AIC-128 have NULL level; pre-ladder rollups
// were all weekly, so NULL resolves to the week rung unless the period
// column says otherwise.
function rungOf(r: Pick<MapRollup, "period" | "level">): 1 | 2 | 3 {
  if (r.level === 3 || r.period === "month") return 3;
  if (r.level === 1 || r.period === "day") return 1;
  return 2;
}

const EXCERPT_CAP = 120;

function firstSentenceExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "(empty)";
  const m = flat.match(/^(.+?[.!?])(?:\s|$)/);
  const sentence = m ? m[1] : flat;
  return sentence.length > EXCERPT_CAP ? sentence.slice(0, EXCERPT_CAP - 1) + "…" : sentence;
}

const QUEUED_LIST_CAP = 20;

function listQueuedCandidates(
  memory: DatabaseSync
): { rows: { id: number; ts: string; tag: string; body: string }[]; total: number } {
  try {
    const rows = memory
      .prepare(`SELECT id, ts, tag, body FROM memory_versions WHERE tag LIKE '%-candidate' ORDER BY id DESC`)
      .all() as { id: number; ts: string; tag: string; body: string }[];
    return { rows: rows.slice(0, QUEUED_LIST_CAP), total: rows.length };
  } catch {
    // memory_versions table not created yet — nothing was ever queued.
    return { rows: [], total: 0 };
  }
}

export function writeMemoryMap(
  memory: DatabaseSync,
  args: { role: { dir: string; name: string } }
): string {
  const rollups = memory
    .prepare(
      `SELECT id, period, period_start, period_end, body, level, parent_id
       FROM rollups ORDER BY period_start DESC, id DESC`
    )
    .all() as MapRollup[];
  const queued = listQueuedCandidates(memory);
  const rungLine = (r: MapRollup) =>
    `${r.period} · ${r.period_start.slice(0, 10)} → ${r.period_end.slice(0, 10)} · id ${r.id}`;

  const out: string[] = [
    `# Memory map — ${args.role.name}`,
    ``,
    `Generated by the reflect ritual — read-only projection of memory.db; edit nothing here.`,
    ``,
  ];

  // The inbox first — the owner's action items outrank the archive.
  if (queued.total > 0) {
    out.push(`## Queued promotions`, ``);
    for (const c of queued.rows) {
      out.push(`- \`${c.tag}\` (saved ${c.ts}) — ${firstSentenceExcerpt(c.body)}`);
    }
    if (queued.total > queued.rows.length) {
      out.push(`- … and ${queued.total - queued.rows.length} older candidate(s)`);
    }
    out.push(``);
  }

  // Level-ordered ladder: months as sections, then weeks newest-first,
  // children nested beneath their parent where parent links exist. Every
  // rollup renders at most once.
  const rendered = new Set<number>();
  const renderChildren = (parentId: number) => {
    for (const c of rollups) {
      if (c.parent_id !== parentId || rendered.has(c.id)) continue;
      rendered.add(c.id);
      out.push(`#### ${rungLine(c)}`, `> ${firstSentenceExcerpt(c.body)}`, ``);
    }
  };
  const months = rollups.filter((r) => rungOf(r) === 3);
  if (months.length > 0) {
    out.push(`## Months`, ``);
    for (const m of months) {
      rendered.add(m.id);
      out.push(`### ${rungLine(m)}`, `> ${firstSentenceExcerpt(m.body)}`, ``);
      renderChildren(m.id);
    }
  }
  const weeks = rollups.filter((r) => rungOf(r) === 2 && !rendered.has(r.id));
  if (weeks.length > 0) {
    out.push(`## Weeks`, ``);
    for (const w of weeks) {
      rendered.add(w.id);
      out.push(`### ${rungLine(w)}`, `> ${firstSentenceExcerpt(w.body)}`, ``);
      renderChildren(w.id);
    }
  }

  out.push(`---`, ``, `Rungs below this line are raw events — ask the coworker to run memory.walk to descend.`, ``);
  const text = out.join("\n");
  const path = args.role.dir + "/../state/memory-map.md";
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text); // overwrite — regenerated, never appended
  } catch {
    // best-effort — the map is a projection, never load-bearing (same
    // discipline as the DREAMS.md diary append above)
  }
  return text;
}

// --- AIC-131 rung 2: the review inbox's owner levers ---

interface CandidateVersion {
  id: number;
  ts: string;
  tag: string;
  body: string;
}

function newestCandidate(memory: DatabaseSync): CandidateVersion | null {
  try {
    return (memory
      .prepare(`SELECT id, ts, tag, body FROM memory_versions WHERE tag LIKE '%-candidate' ORDER BY id DESC LIMIT 1`)
      .get() ?? null) as CandidateVersion | null;
  } catch {
    return null; // memory_versions table not created yet — nothing queued
  }
}

// bin/aicw memory-approve — apply the newest queued candidate to MEMORY.md
// exactly the way a confident in-ritual promotion would (before-snapshot +
// injection scan + cap via semantic.propose), then consume the queue item
// by retagging it `-applied`. A rejected candidate (injection/cap) stays
// queued — refusing quietly is worse than leaving it for the owner.
export function approvePendingPromotion(args: {
  memory: DatabaseSync;
  semantic: SemanticMemory;
  role: { dir: string; name: string };
}): { applied: boolean; tag?: string; reason: string } {
  const cand = newestCandidate(args.memory);
  if (!cand) return { applied: false, reason: "no queued -candidate versions in memory_versions" };
  const dreamId = cand.tag.replace(/-candidate$/, "");
  const priorBody = args.semantic.read();
  args.memory.exec("BEGIN");
  try {
    saveVersion(args.memory, dreamId + "-before", priorBody);
    const r = args.semantic.propose(cand.body, cand.tag);
    if (!r.accepted) throw new Error(`semantic rejected: ${r.reason}`);
    args.memory.prepare(`UPDATE memory_versions SET tag = ? WHERE id = ?`).run(dreamId + "-applied", cand.id);
    args.memory.exec("COMMIT");
  } catch (err) {
    args.memory.exec("ROLLBACK");
    return { applied: false, tag: cand.tag, reason: String(err) };
  }
  appendDreamDiary({ role: args.role }, cand.tag, {
    added: diffBullets(priorBody, cand.body),
    dropped: diffBullets(cand.body, priorBody),
    note: `APPLIED — owner approved ${cand.tag} via bin/aicw memory-approve`,
  });
  writeMemoryMap(args.memory, args); // keep the projected queue truthful
  return {
    applied: true,
    tag: cand.tag,
    reason: `applied ${cand.tag} (${cand.body.length} chars; prior snapshot saved as ${dreamId}-before)`,
  };
}

// bin/aicw memory-strike — remove MEMORY.md bullet(s) containing a text
// fragment. Saves a pre-strike snapshot to memory_versions (the same table
// bin/memory-rollback.sh reads), refuses when the fragment matches zero or
// more than five bullets — a vague fragment must not quietly gut the
// semantic memory — and records the strike in the dream diary.
const STRIKE_MAX_BULLETS = 5;

export function strikeMemoryBullets(args: {
  memory: DatabaseSync;
  semantic: SemanticMemory;
  role: { dir: string; name: string };
  fragment: string;
}): { removed: number; reason: string } {
  const body = args.semantic.read();
  const lines = body.split(/\r?\n/);
  const hits = lines.filter((l) => /^\s*[-*]\s+\S/.test(l) && l.includes(args.fragment));
  if (hits.length === 0) {
    return { removed: 0, reason: `no MEMORY.md bullets contain "${args.fragment}"` };
  }
  if (hits.length > STRIKE_MAX_BULLETS) {
    return { removed: 0, reason: `fragment matches ${hits.length} bullets — refusing to strike more than ${STRIKE_MAX_BULLETS}; use a more specific fragment` };
  }
  const struck = new Set(hits);
  const newBody = lines.filter((l) => !struck.has(l)).join("\n");
  const strikeId = `strike-${new Date().toISOString().slice(0, 10)}`;
  saveVersion(args.memory, strikeId + "-before", body);
  const r = args.semantic.propose(newBody, `strike:${args.fragment}`);
  if (!r.accepted) {
    return { removed: 0, reason: `semantic rejected strike: ${r.reason} (pre-strike snapshot saved as ${strikeId}-before)` };
  }
  appendDreamDiary({ role: args.role }, strikeId, {
    added: [],
    dropped: hits.map((h) => h.replace(/^\s*[-*]\s*/, "").trim()),
    note: `STRUCK — owner removed ${hits.length} bullet(s) matching "${args.fragment}" via bin/aicw memory-strike`,
  });
  writeMemoryMap(args.memory, args); // keep the projection in step
  return { removed: hits.length, reason: `removed ${hits.length} bullet(s); pre-strike snapshot saved as ${strikeId}-before` };
}
