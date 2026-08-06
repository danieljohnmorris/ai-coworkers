// AIC-71 — reactions log. A compact human-in-the-loop reinforcement signal:
// operators leave 👍 / 👎 (optionally with a note) on what the coworker is
// doing, and unread reactions surface in the next tick's perception. Same
// cursor-based one-time-presentation semantics as the inbox — a reaction is
// shown once, then marked read so it doesn't dominate future context.
//
// Path: coworkers/<name>/state/reactions.log  (JSONL, one reaction per line)
//       coworkers/<name>/state/reactions.log.cursor  (byte offset)

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Verdict = "👍" | "👎";

export interface Reaction {
  ts: string;
  verdict: Verdict;
  note?: string;
}

export interface Reactions {
  read(): Reaction[];             // all reactions, newest last
  unread(): Reaction[];           // reactions since last markAllRead
  markAllRead(): void;
  append(r: Omit<Reaction, "ts"> & { ts?: string }): void;
}

export function openReactions(path: string): Reactions {
  const cursorPath = path + ".cursor";
  const readCursor = (): number => {
    if (!existsSync(cursorPath)) return 0;
    const n = Number(readFileSync(cursorPath, "utf8").trim());
    return Number.isFinite(n) ? n : 0;
  };
  const writeCursor = (n: number) => writeFileSync(cursorPath, String(n));

  const parseSlice = (slice: string): Reaction[] => {
    const out: Reaction[] = [];
    for (const line of slice.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Reaction;
        if (obj && (obj.verdict === "👍" || obj.verdict === "👎") && typeof obj.ts === "string") {
          out.push(obj);
        }
      } catch { /* skip malformed lines */ }
    }
    return out;
  };

  return {
    read(): Reaction[] {
      return existsSync(path) ? parseSlice(readFileSync(path, "utf8")) : [];
    },
    unread(): Reaction[] {
      if (!existsSync(path)) return [];
      const full = readFileSync(path, "utf8");
      const from = readCursor();
      return parseSlice(full.slice(from));
    },
    markAllRead(): void {
      if (!existsSync(path)) return;
      const full = readFileSync(path, "utf8");
      writeCursor(full.length);
    },
    append(r): void {
      mkdirSync(dirname(path), { recursive: true });
      const rec: Reaction = {
        ts: r.ts ?? new Date().toISOString(),
        verdict: r.verdict,
        ...(r.note ? { note: r.note } : {}),
      };
      appendFileSync(path, JSON.stringify(rec) + "\n");
    },
  };
}

// Render a compact block for injection into the deliberate prompt. Kept short
// so a wall of positive reactions doesn't dominate the context.
export function renderReactions(unread: Reaction[]): string {
  if (!unread.length) return "";
  return unread
    .map((r) => `- ${r.verdict} [${r.ts.slice(11, 16)}]${r.note ? ` — ${r.note}` : ""}`)
    .join("\n");
}
