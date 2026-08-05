// AIC-56 — prompt-level compaction. When a prior-step outcome is large
// enough that truncation would drop the middle, ask a cheap LLM to
// summarise it into a short paragraph the model can actually use.
// Cache by content hash so we don't re-summarise the same blob every step.

import { chat, type LLMConfig } from "./llm.ts";
import { createHash } from "node:crypto";

const cache = new Map<string, string>();
const MAX_CACHE = 200;

export async function compactOutcome(
  llm: LLMConfig,
  outcome: unknown,
  thresholdChars = 6000,
): Promise<string> {
  const json = JSON.stringify(outcome);
  if (json.length <= thresholdChars) return json;
  const key = createHash("sha1").update(json).digest("hex").slice(0, 16);
  const hit = cache.get(key);
  if (hit) return hit;

  try {
    const res = await chat(llm, [
      { role: "system", content:
        "You compress a tool-call result into a short paragraph so an agent " +
        "can reason about it without loading the full payload. Preserve exact " +
        "identifiers (ticket keys, UUIDs, URLs) verbatim. Under 500 chars." },
      { role: "user", content:
        "Summarise this tool outcome for the calling agent:\n```\n" +
        json.slice(0, 40_000) + "\n```" },
    ], { temperature: 0.1, maxTokens: 300 });
    const summary = `[COMPACTED — ${json.length}→${res.content.length} chars] ${res.content.trim()}`;
    if (cache.size > MAX_CACHE) {
      // Drop oldest ~20 entries when we hit the cap.
      for (const k of [...cache.keys()].slice(0, 20)) cache.delete(k);
    }
    cache.set(key, summary);
    return summary;
  } catch {
    // Fall back to plain truncation on compaction failure.
    return json.slice(0, thresholdChars) + "…[truncated, compaction failed]";
  }
}
