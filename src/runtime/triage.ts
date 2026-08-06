// AIC-47 — cheap-first model routing. The tick loop's `quiet gate` already
// skips deliberation when nothing changed AND no work is sensed AND no
// promise is due. But the middle ground — "perception changed slightly
// (tempo counter, one sensor reordered items) but nothing is genuinely
// actionable" — still reaches the expensive COWORKER_MODEL. Most of the
// time it says "noop, backlog quiet" after burning a full prompt.
//
// This preflight asks a small/cheap model to make that yes/no decision
// with a compressed perception. If the cheap model says "nothing to do",
// we skip the expensive deliberate entirely and log a tick.triage-skip
// event. If it says "act", we proceed exactly as before — the cheap
// model has NO say over WHAT to do, only WHETHER.
//
// Configure by setting TRIAGE_MODEL in env; when unset, this module is
// bypassed and behaviour is unchanged.

import { chat, type LLMConfig } from "./llm.ts";
import type { Perception } from "./deliberate.ts";

export interface TriageDecision {
  act: boolean;
  reason: string;
  rawOutput?: string;
}

// Compact perception summary — deliberately terse to keep the cheap model
// under a few hundred tokens per call. We give it just enough to decide
// "is anything obviously worth acting on"; not enough to make a full
// judgement (which is deliberate's job).
export function summariseForTriage(perception: Perception): string {
  const sensorSummary = perception.sensors
    .map((s) => {
      if (s.error) return `- ${s.name}: error(${s.error.slice(0, 60)})`;
      const r = s.result as Record<string, unknown> | null;
      if (!r || typeof r !== "object") return `- ${s.name}: ${JSON.stringify(r).slice(0, 80)}`;
      // Prefer array counts (issues, mentions, prs, replies) — these are
      // the fields sensorSuggestsWork() checks upstream.
      const arrays = Object.entries(r).filter(([, v]) => Array.isArray(v));
      if (arrays.length) return `- ${s.name}: ${arrays.map(([k, v]) => `${k}=${(v as unknown[]).length}`).join(" ")}`;
      return `- ${s.name}: ${Object.keys(r).slice(0, 5).join(",")}`;
    })
    .join("\n");
  const parts: string[] = [];
  parts.push(`# Sensors\n${sensorSummary || "(none)"}`);
  if (perception.pendingPromises.length) parts.push(`# Pending promises\n${perception.pendingPromises.length} due`);
  if (perception.inboxUnread) parts.push(`# Inbox unread\n${perception.inboxUnread.slice(0, 200)}`);
  if (perception.reactionsUnread) parts.push(`# Reactions unread\n${perception.reactionsUnread.slice(0, 200)}`);
  parts.push(`# Tempo\ncallsPerHour=${perception.tempo.callsPerHour} noopRatio=${perception.tempo.noopRatioLast100} secSinceChange=${perception.tempo.secondsSinceLastPerceptionChange}`);
  return parts.join("\n\n");
}

const TRIAGE_SYSTEM = [
  "You are a preflight triage — a cheap check before an expensive planning pass.",
  "Given a compact perception, decide ONE thing: is there anything obviously worth acting on RIGHT NOW?",
  '",',
  "Return JSON: {\"act\": true|false, \"reason\": \"<1-sentence explanation>\"}.",
  "",
  "Say act=false when:",
  "- All sensors show empty arrays (issues=0 mentions=0 prs=0 etc.).",
  "- No pending promises, no unread inbox, no unread reactions.",
  "- Tempo shows nothing changed recently AND the coworker was quiet.",
  "",
  "Say act=true when:",
  "- ANY sensor shows a non-empty backlog you don't recognise as handled.",
  "- Unread inbox or reactions from the manager.",
  "- A promise is due to fire.",
  "- Tempo indicates the coworker has been quiet TOO long relative to the workload seen.",
  "",
  "Bias toward act=true when unsure — a wasted deliberate is cheap compared to missing real work.",
].join("\n");

export async function triage(llm: LLMConfig, perception: Perception): Promise<TriageDecision> {
  try {
    const res = await chat(llm, [
      { role: "system", content: TRIAGE_SYSTEM },
      { role: "user", content: summariseForTriage(perception) },
    ], { json: true, temperature: 0.1, maxTokens: 120 });
    const raw = res.content.trim();
    try {
      const parsed = JSON.parse(raw) as { act?: unknown; reason?: unknown };
      const act = parsed.act === true || parsed.act === "true";
      const reason = typeof parsed.reason === "string" ? parsed.reason : "";
      return { act, reason, ...(act ? {} : { rawOutput: raw.slice(0, 300) }) };
    } catch {
      // Malformed response — bias toward act=true so we don't silently
      // strand real work on a triage-model hiccup.
      return { act: true, reason: "triage output unparseable — falling through to full deliberate", rawOutput: raw.slice(0, 300) };
    }
  } catch (err) {
    // Same bias on network / auth error: fall through to full deliberate
    // rather than skip a tick because the cheap model was unreachable.
    return { act: true, reason: `triage error, falling through: ${String(err).slice(0, 200)}` };
  }
}
