// memory.walk — the drill-down reader over the memory ladder (AIC-128 stage 2,
// ADR-0008). Answers "why do I remember this?" by walking from the coarsest
// matching rollup (month → week → day) down to the exact raw events, and
// returns an audit trace with one row per step.
//
// PURITY — divergence from Headlong, per ADR-0008: Headlong's design has the
// *model* navigate each ladder level in its own context. We keep this tool
// pure: deterministic SQL + TypeScript navigation, ZERO LLM calls inside the
// tool (the walk function takes no llm config at all — see memWalk below).
// The product pitch is that most ticks never reach the model, so the model
// issues one memory.walk call and gets the whole pre-navigated trace back.
//
// Entry point is lexical, on purpose (ADR-0008 "Not doing": no embeddings):
//   - hot rung:  FTS5 over events_fts (porter stemming — "running" hits "runs")
//   - ladder:    SQL LIKE token-overlap scoring over rollup bodies
//   - confidence = distinct matched query tokens / distinct query tokens,
//     best candidate wins. Below CONFIDENCE_THRESHOLD we REFUSE with
//     {refused: true, reason} and issue no queries beyond the entry scan —
//     walking down a weak keyword match with authoritative-looking citations
//     is exactly the confident-wrong failure mode ADR-0008 engineers against.
//     Refusal is a first-class outcome, not an error.
//
// Raw events resolve against events UNION events_archive — the archive holds
// the pre-retention ids (AIC-127), so the bottom rung survives pruning.
// Rollups with NULL source_range (legacy rows, or spans that failed write-time
// validation) are honest dead ends: they are reported and annotated, never
// drilled through, and provenance is never synthesised (ADR-0008).

import type { ToolDef, ToolCtx } from "../runtime/tools.ts";
import { DatabaseSync } from "node:sqlite";
import { openMemory } from "../runtime/memory.ts";
import { join } from "node:path";

// --- tunables (documented decisions, not config — ADR-0008 ships fixed
// values and revisits only with usage telemetry) ---
//
// CONFIDENCE_THRESHOLD = 0.5: at least half the distinct query tokens must
// match somewhere before we are willing to walk. A single shared keyword out
// of a three-token query (0.33) is coincidence, not an entry point.
export const CONFIDENCE_THRESHOLD = 0.5;
// Cap of best-scoring rollup candidates kept per ladder level. Three rungs of
// three keeps the returned trace readable; Headlong's cost model allows ~10
// per level, we stay tighter.
export const CANDIDATES_PER_LEVEL = 3;
// Hard ceiling on raw events returned by one walk, across every branch.
export const RAW_EVENT_CAP = 40;
// Per-event payload truncation (~2 KB each keeps the worst case ~80 KB).
export const PAYLOAD_CAP = 2048;
// How many hot FTS rows the entry scan pulls as raw evidence.
const FTS_ENTRY_LIMIT = 25;
// Defensive: the ladder is acyclic by construction (parents are strictly
// coarser); this caps descent if corrupted data ever links a cycle.
const MAX_WALK_DEPTH = 8;

export interface WalkTraceStep {
  level: number; // 3=month, 2=week, 1=day, 0=raw event
  id: number;    // rollups.id for rungs, events id for raw rows
  why: string;   // human/agent-readable audit reason for this step
}

export interface WalkEvent {
  id: number;
  ts: string;
  kind: string;
  payload: string; // truncated to ~PAYLOAD_CAP
  source: "events" | "events_archive";
}

export interface MemWalkResult {
  refused: boolean;       // first-class refusal outcome (ADR-0008)
  reason?: string;        // present when refused
  confidence: number;     // matched-token fraction of the winning entry
  queryTokens: string[];  // distinct tokens the query tokenized to
  matchedTokens: string[];// tokens the winning entry matched
  trace: WalkTraceStep[]; // ordered audit rows: coarse → fine, raw last
  events: WalkEvent[];    // capped raw evidence, best match first
  truncated: boolean;     // true when RAW_EVENT_CAP / PAYLOAD_CAP bit
}


// How many of the query tokens occur as tokens of `text` (used to rank
// children and raw events; substring luck is only allowed at the LIKE entry).
function overlap(text: string, tokens: string[]): number {
  const hay = new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []));
  return tokens.reduce((n, t) => n + (hay.has(t) ? 1 : 0), 0);
}

// Parse a rollup source_range ("[first,last]" JSON) into a span. Anything
// malformed is a dead end — read-side link-rot defense complementing the
// write-side validation in memory.ts eventIdsResolve.
function parseRange(raw: unknown): [number, number] | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(x))) {
      return [v[0], v[1]];
    }
  } catch { /* malformed JSON — treat as unlinked */ }
  return null;
}

interface RollupCandidate {
  id: number;
  level: number | null;
  parentId: number | null;
  sourceRange: [number, number] | null;
  matched: string[]; // query tokens LIKE-matched in the body
}

interface FtsHit {
  id: number;
  ts: string;
  kind: string;
  payload: string;
}

export interface EntryScan {
  tokens: string[];
  rollups: RollupCandidate[]; // sorted best-first
  ftsHits: FtsHit[];
  confidence: number;
  matchedTokens: string[]; // tokens matched by the winning side
}

// The entry scan is the ONLY database work a refused walk performs. Kept as
// an exported unit so tests can prove the refusal path issues no further
// queries (ADR-0008 acceptance).
export function entryScan(events: DatabaseSync, memory: DatabaseSync, query: string): EntryScan {
  // Distinct [a-z0-9]+ tokens, lowercased — mirrors what both the FTS
  // unicode61 tokenizer and the LIKE scan can see.
  const tokens = [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
  if (tokens.length === 0) {
    return { tokens, rollups: [], ftsHits: [], confidence: 0, matchedTokens: [] };
  }

  // Ladder rungs — SQL LIKE token overlap over rollup bodies. Tokens are
  // [a-z0-9]+ by construction, so they cannot contain LIKE wildcards and no
  // escaping is needed; SQLite LIKE is ASCII-case-insensitive, matching the
  // already-lowercased tokens.
  const byId = new Map<number, RollupCandidate>();
  for (const tok of tokens) {
    const rows = memory
      .prepare(`SELECT id, level, parent_id, source_range FROM rollups WHERE body LIKE ?`)
      .all(`%${tok}%`) as { id: number; level: number | null; parent_id: number | null; source_range: string | null }[];
    for (const row of rows) {
      let c = byId.get(row.id);
      if (!c) {
        c = {
          id: row.id,
          level: row.level,
          parentId: row.parent_id,
          sourceRange: parseRange(row.source_range),
          matched: [],
        };
        byId.set(row.id, c);
      }
      c.matched.push(tok);
    }
  }
  const rollups = [...byId.values()].sort(
    (a, b) => b.matched.length - a.matched.length || a.id - b.id
  );

  // Hot rung — FTS5. One existence probe per token (exact matched-token set,
  // stemming included) plus one OR-fetch for raw evidence rows. events_fts
  // may be missing on an events db that never ran initEpisodic — that side
  // then simply contributes nothing.
  const hotMatched: string[] = [];
  let ftsHits: FtsHit[] = [];
  try {
    for (const tok of tokens) {
      const hit = events
        .prepare(`SELECT 1 FROM events_fts WHERE events_fts MATCH ? LIMIT 1`)
        .get(`"${tok}"`);
      if (hit) hotMatched.push(tok);
    }
    ftsHits = events
      .prepare(`SELECT event_id AS id, ts, kind, payload FROM events_fts WHERE events_fts MATCH ? LIMIT ?`)
      .all(tokens.map((t) => `"${t}"`).join(" OR "), FTS_ENTRY_LIMIT) as FtsHit[];
  } catch { /* no events_fts — hot rung absent, ladder only */ }

  const rollupBest = rollups[0]?.matched.length ?? 0;
  const winnerIsRollup = rollupBest >= hotMatched.length; // ties prefer the ladder
  const matchedTokens = winnerIsRollup ? rollups[0]?.matched ?? [] : hotMatched;
  const confidence = tokens.length
    ? Math.max(rollupBest, hotMatched.length) / tokens.length
    : 0;
  return { tokens, rollups, ftsHits, confidence, matchedTokens };
}

// The pure walk. Deterministic SQL/TS only — no LLM config parameter exists
// anywhere in this signature (purity is part of the AIC-128 contract).
export function memWalk(events: DatabaseSync, memory: DatabaseSync, query: string): MemWalkResult {
  const scan = entryScan(events, memory, query);
  if (scan.tokens.length === 0) {
    return {
      refused: true,
      reason: "query tokenized to no searchable tokens",
      confidence: 0, queryTokens: [], matchedTokens: [],
      trace: [], events: [], truncated: false,
    };
  }
  const n = scan.tokens.length;
  if (scan.confidence < CONFIDENCE_THRESHOLD) {
    return {
      refused: true,
      reason:
        `no confident entry point: best lexical match ${scan.matchedTokens.length}/${n} ` +
        `(${scan.confidence.toFixed(2)}) is below the ${CONFIDENCE_THRESHOLD} threshold — ` +
        `refusing rather than walking a weak keyword match (ADR-0008)`,
      confidence: scan.confidence,
      queryTokens: scan.tokens,
      matchedTokens: scan.matchedTokens,
      trace: [],
      events: [],
      truncated: false,
    };
  }

  const trace: WalkTraceStep[] = [];
  const found = new Map<number, WalkEvent & { score: number; why: string }>();

  const addEvent = (
    row: FtsHit,
    source: WalkEvent["source"],
    score: number,
    why: string
  ): void => {
    const payload =
      row.payload.length > PAYLOAD_CAP ? row.payload.slice(0, PAYLOAD_CAP) + "…[truncated]" : row.payload;
    const prev = found.get(row.id);
    if (prev && prev.score >= score) return; // dedupe by event id, keep best score
    found.set(row.id, { id: row.id, ts: row.ts, kind: row.kind, payload, source, score, why });
  };

  // Hot FTS hits are raw evidence in their own right — they cover events too
  // recent to have been rolled up yet, which the ladder alone would miss.
  for (const hit of scan.ftsHits) {
    addEvent(hit, "events", overlap(`${hit.kind} ${hit.payload}`, scan.tokens), "hot FTS entry hit");
  }

  // Ladder walk: coarsest level present → children → source_range spans.
  const ladder = scan.rollups.filter((r) => r.level !== null);
  if (ladder.length > 0) {
    const startLevel = Math.max(...ladder.map((r) => r.level as number));
    const frontier = ladder
      .filter((r) => r.level === startLevel)
      .slice(0, CANDIDATES_PER_LEVEL); // rollups already sorted best-first
    for (const c of frontier) {
      trace.push({
        level: startLevel,
        id: c.id,
        why: `entry: best lexical match at level ${startLevel} (${c.matched.length}/${n} tokens: ${c.matched.join(", ")})`,
      });
    }

    // Descend parent → children, keeping the best CANDIDATES_PER_LEVEL per
    // level (children with no lexical tie to the query are pruned before
    // ranking). A rung with no children — or already at day level — is
    // terminal and resolves its own source_range below.
    let current = frontier;
    const terminals: RollupCandidate[] = [];
    for (let depth = 0; depth < MAX_WALK_DEPTH && current.length > 0; depth++) {
      const kids: { cand: RollupCandidate; parentLevel: number; overlapTokens: number }[] = [];
      for (const parent of current) {
        if ((parent.level ?? 1) <= 1) { terminals.push(parent); continue; }
        const rows = memory
          .prepare(`SELECT id, level, parent_id, source_range, body FROM rollups WHERE parent_id = ?`)
          .all(parent.id) as { id: number; level: number | null; parent_id: number | null; source_range: string | null; body: string }[];
        const before = kids.length;
        for (const row of rows) {
          const m = overlap(row.body, scan.tokens);
          if (m === 0) continue;
          kids.push({
            cand: {
              id: row.id,
              level: row.level,
              parentId: row.parent_id,
              sourceRange: parseRange(row.source_range),
              matched: scan.tokens.filter((t) => row.body.toLowerCase().includes(t)),
            },
            parentLevel: parent.level as number,
            overlapTokens: m,
          });
        }
        // No children survived lexical pruning (or none exist): the rung
        // cannot be descended and resolves its own span below.
        if (kids.length === before) terminals.push(parent);
      }
      kids.sort((a, b) => b.overlapTokens - a.overlapTokens || a.cand.id - b.cand.id);
      current = kids.slice(0, CANDIDATES_PER_LEVEL).map((k) => k.cand);
      // Trace only the survivors — dropped children were never walked.
      for (const k of kids.slice(0, CANDIDATES_PER_LEVEL)) {
        trace.push({
          level: k.cand.level ?? k.parentLevel - 1,
          id: k.cand.id,
          why: `child of rollup ${k.cand.parentId} (${k.overlapTokens}/${n} tokens)`,
        });
      }
    }
    terminals.push(...current);

    // Terminal rungs resolve their raw-event span against hot ∪ archive.
    // Unlinked rungs (NULL/malformed source_range) are annotated in place —
    // reported, never drilled through (ADR-0008: no synthesised provenance).
    for (const term of terminals) {
      const row = trace.find((t) => t.id === term.id && t.level > 0);
      if (!term.sourceRange) {
        if (row) row.why += " — unlinked (no source_range), cannot drill further";
        continue;
      }
      const [a, b] = term.sourceRange;
      const span = resolveSpan(events, a, b);
      for (const ev of span) {
        addEvent(
          ev.row, ev.source,
          overlap(`${ev.row.kind} ${ev.row.payload}`, scan.tokens),
          `rollup ${term.id} source_range [${a},${b}]`
        );
      }
    }
  }

  // Caps: rank raw events by lexical overlap (best first, id as tiebreak),
  // keep at most RAW_EVENT_CAP.
  let ranked = [...found.values()].sort((x, y) => y.score - x.score || x.id - y.id);
  const truncated = ranked.length > RAW_EVENT_CAP;
  if (truncated) ranked = ranked.slice(0, RAW_EVENT_CAP);
  for (const e of ranked) {
    trace.push({ level: 0, id: e.id, why: `${e.why} (${e.score}/${n} tokens)` });
  }

  return {
    refused: false,
    confidence: scan.confidence,
    queryTokens: scan.tokens,
    matchedTokens: scan.matchedTokens,
    trace,
    events: ranked,
    truncated,
  };
}

// Resolve an event-id span against the hot table first, then the AIC-127
// archive (which holds the carried-over ids for pruned events). An id present
// in both (crash window between archive-insert and hot-delete) is reported
// once, as hot. The archive table is guarded — a pre-AIC-127 events db
// simply has no cold rung.
function resolveSpan(
  events: DatabaseSync,
  a: number,
  b: number
): { row: FtsHit; source: WalkEvent["source"] }[] {
  const out = new Map<number, { row: FtsHit; source: WalkEvent["source"] }>();
  const hot = events
    .prepare(`SELECT id, ts, kind, payload FROM events WHERE id BETWEEN ? AND ?`)
    .all(a, b) as FtsHit[];
  for (const row of hot) out.set(row.id, { row, source: "events" });
  try {
    const cold = events
      .prepare(`SELECT id, ts, kind, payload FROM events_archive WHERE id BETWEEN ? AND ?`)
      .all(a, b) as FtsHit[];
    for (const row of cold) {
      if (!out.has(row.id)) out.set(row.id, { row, source: "events_archive" });
    }
  } catch { /* no events_archive table — hot span only */ }
  return [...out.values()];
}

// --- tool wiring (lazy-opens the coworker's own dbs, mirroring the
// memory.ts openLazy convention; read-only in effect) ---

let eventsDb: DatabaseSync | null = null;
let memoryDb: DatabaseSync | null = null;

function openLazy(ctx: ToolCtx): { events: DatabaseSync; memory: DatabaseSync } {
  const repoRoot = new URL("../..", import.meta.url).pathname;
  const stateDir = join(repoRoot, "coworkers", ctx.coworker, "state");
  if (!eventsDb) eventsDb = new DatabaseSync(join(stateDir, "events.db"));
  // openMemory (not a bare handle) so the ladder columns exist even on a
  // coworker whose memory.db predates AIC-128 — same migration the runtime
  // runs at startup, idempotent CREATE/ALTER.
  if (!memoryDb) memoryDb = openMemory(join(stateDir, "memory.db"));
  return { events: eventsDb, memory: memoryDb };
}

export const memWalkTool: ToolDef = {
  name: "memory.walk",
  kind: "action",
  description:
    "Drill down your own memory ladder: find where a memory comes from by walking from the coarsest matching summary (month/week/day rollup) down to the exact raw events, every step returned as an audit trace. Read-only and deterministic. Refuses (refused: true) when no entry point confidently matches the query — a refusal means 'not memorised', not an error. Use for 'why do I believe this?' / 'show me the events behind that summary'; use memory.search for plain keyword hits.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "Natural-language topic, e.g. 'parser bug on ILO-509' or 'slack escalation policy'.",
      },
    },
  },
  handler: async (input: { query: string }, ctx: ToolCtx) => {
    const { events, memory } = openLazy(ctx);
    return memWalk(events, memory, input.query);
  },
};

export const memWalkTools: ToolDef[] = [memWalkTool];
