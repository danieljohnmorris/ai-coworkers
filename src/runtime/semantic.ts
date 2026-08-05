// Semantic memory — a small human-editable markdown file the coworker reads
// every tick and updates via the reflective ritual. Hard character cap forces
// distillation instead of unbounded growth.
//
// Layout:
//   coworkers/<name>/state/memory/MEMORY.md      < 2KB
//
// Reads: appended to the system prompt each tick.
// Writes: gated through scan() (injection safety) and enforceCap() (size).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { scan } from "./injection.ts";

export interface SemanticMemory {
  read(): string;
  propose(newBody: string, source: string): {
    accepted: boolean;
    reason: string;
    suspicious?: boolean;
    hits?: string[];
    overCap?: boolean;
  };
}

const DEFAULT_CAP = 2048;

export function openSemantic(path: string, cap = DEFAULT_CAP): SemanticMemory {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "");
  return {
    read(): string {
      return readFileSync(path, "utf8");
    },
    propose(newBody, source) {
      const s = scan(newBody);
      if (s.suspicious) {
        return { accepted: false, reason: "flagged by injection scanner", suspicious: true, hits: s.hits };
      }
      if (newBody.length > cap) {
        return { accepted: false, reason: `exceeds cap ${cap} (got ${newBody.length})`, overCap: true };
      }
      writeFileSync(path, newBody);
      return { accepted: true, reason: `written from ${source}` };
    },
  };
}
