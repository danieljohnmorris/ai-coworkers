// Entity evaluator — a post-deliberate hook that extracts entities and
// workspace facts from what the coworker just perceived, thought, and
// did, and writes them into the EXISTING filesystem-first stores:
//   - people      → state/entities/people/<handle>.md   (see entities.ts)
//   - projects    → state/entities/projects/<key>.md    (see entities.ts)
//   - facts       → state/notes.md via the same append/dedup shape as
//                   the memory.note tool (see tools/memory.ts)
//
// Opt-in via EXTRACT_ENTITIES=1. Model is TRIAGE_MODEL if set (cheap),
// else COWORKER_MODEL. Cost is logged as `evaluator.run`; failures are
// swallowed and logged as `evaluator.error` — never crash the tick.
//
// Contract with human curation: an entity file that already exists is
// only appended to if it already has an `## auto-generated` section.
// A curated file (any file without that heading) is treated as
// human-owned and left alone. See ADR 0006.

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { chat, type LLMConfig } from "./llm.ts";
import type { Log } from "./log.ts";
import type { Perception } from "./deliberate.ts";
import type { EntityStore } from "./entities.ts";

export interface EvaluatorInput {
  perception: Perception;
  priorSteps: { tool: string; input: unknown; outcome: unknown }[];
  thoughts: string;                       // recent deliberate thoughts joined
}

export interface EvaluatorCtx {
  llm: LLMConfig;                         // TRIAGE_MODEL ?? COWORKER_MODEL
  entities: EntityStore;
  entitiesDir: string;                    // state/entities/
  notesPath: string;                      // state/notes.md
  log: Log;
  dryRun: boolean;
}

export interface ExtractedPerson  { handle: string; oneLine: string }
export interface ExtractedProject { key: string; oneLine: string }
export interface Extraction {
  people: ExtractedPerson[];
  projects: ExtractedProject[];
  workspaceFacts: string[];
}

// Marker heading that separates evaluator-owned prose from human-owned
// prose within a single entity file. If a file lacks this heading it is
// treated as fully curated and the evaluator will not touch it.
export const AUTO_HEADING = "## auto-generated";

// Keep the notes.md format identical to memory.note's shape so a reader
// tailing that file can't tell whether the entry came from the coworker
// or from this evaluator (the [auto] tag is the only tell).
const NOTES_CAP = 4096;
const HANDLE_ALLOW = /^[a-zA-Z0-9._-]+$/;

// Prompt is deliberately terse. We are running on the cheap model on
// every tick — every extra token multiplies fleet-wide cost. The tool
// is intentionally strict: the model may return empty arrays when the
// tick was uneventful (most of them are), and it is told to.
export const EVALUATOR_SYSTEM = [
  "You extract entities and workspace facts from one tick of a long-running AI coworker.",
  "You are cheap and frequent — return empty arrays if the tick was uneventful. Do not invent.",
  "",
  "Return STRICT JSON with this exact shape:",
  '{ "people":         [{ "handle": "<slug>", "oneLine": "<<=120 chars>" }],',
  '  "projects":       [{ "key":    "<slug>", "oneLine": "<<=120 chars>" }],',
  '  "workspaceFacts": [ "<one durable fact per string, <=200 chars>" ] }',
  "",
  "Rules:",
  "- handle / key are lowercase, kebab-or-dot slugs matching /^[a-zA-Z0-9._-]+$/.",
  "  Use the identifier the coworker actually saw (github login, linear team key,",
  "  slack handle without @). Never invent a handle to fit a real name.",
  "- oneLine is a single factual sentence — role, relationship, or defining trait.",
  "  Not a summary of what happened this tick.",
  "- workspaceFacts capture DURABLE truths about how the world works — team",
  '  retirements, deprecated projects, escalation channels, "X only ships on',
  '  Fridays". NOT episodic events ("Dan opened PR #42").',
  "- Empty arrays are the correct answer when nothing durable was observed.",
  "- Output JSON only. No prose, no code fences.",
].join("\n");

export function buildEvaluatorUserPrompt(input: EvaluatorInput): string {
  const sensorBlurb = input.perception.sensors
    .map((s) => {
      if (s.error) return `- ${s.name}: error`;
      try { return `- ${s.name}: ${JSON.stringify(s.result).slice(0, 400)}`; }
      catch { return `- ${s.name}: (unserialisable)`; }
    })
    .join("\n") || "(none)";
  const actionBlurb = input.priorSteps
    .map((s) => {
      try { return `- ${s.tool} ${JSON.stringify(s.input).slice(0, 200)}`; }
      catch { return `- ${s.tool}`; }
    })
    .join("\n") || "(none)";
  return [
    `# Sensors this tick\n${sensorBlurb}`,
    `# Actions this tick\n${actionBlurb}`,
    `# Recent thoughts\n${input.thoughts || "(none)"}`,
  ].join("\n\n");
}

// Read the last N chars of notes.md and return a lowercased blob for
// coarse substring dedup. Cheap: bounded by the 4 KB cap on notes.md.
function tailNotesLower(path: string, chars = 4096): string {
  if (!existsSync(path)) return "";
  try {
    const text = readFileSync(path, "utf8");
    return text.slice(-chars).toLowerCase();
  } catch { return ""; }
}

function trimNotesToCap(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const parts = text.split(/(?=\n## )/);
  while (parts.length > 1 && parts.join("").length > cap) parts.shift();
  return parts.join("");
}

function appendNote(path: string, body: string): void {
  const ts = new Date().toISOString();
  const entry = `\n## ${ts}  [auto]\n${body}\n`;
  let existing = "";
  try { if (existsSync(path)) existing = readFileSync(path, "utf8"); } catch { /* empty */ }
  const combined = trimNotesToCap(existing + entry, NOTES_CAP);
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* empty */ }
  writeFileSync(path, combined);
}

// Write to an entity file only if:
//   - file does not exist        → create with auto-generated section
//   - file exists AND has the    → append oneLine under it (dedup)
//     auto-generated heading
//   - file exists WITHOUT the    → skip; humans own it
//     heading
export function writeEntityFile(
  entityPath: string,
  oneLine: string,
): { wrote: "created" | "appended" | "skipped-curated" | "skipped-dup" | "skipped-invalid"; path: string } {
  const trimmed = oneLine.trim();
  if (!trimmed) return { wrote: "skipped-invalid", path: entityPath };
  try { mkdirSync(dirname(entityPath), { recursive: true }); } catch { /* empty */ }
  if (!existsSync(entityPath)) {
    writeFileSync(entityPath, `${AUTO_HEADING}\n${trimmed}\n`);
    return { wrote: "created", path: entityPath };
  }
  const existing = readFileSync(entityPath, "utf8");
  if (!existing.includes(AUTO_HEADING)) {
    return { wrote: "skipped-curated", path: entityPath };
  }
  // Dedup: don't append the same oneLine twice.
  if (existing.includes(trimmed)) return { wrote: "skipped-dup", path: entityPath };
  const suffix = existing.endsWith("\n") ? "" : "\n";
  appendFileSync(entityPath, `${suffix}${trimmed}\n`);
  return { wrote: "appended", path: entityPath };
}

// Parse strict — the prompt tells the model to return JSON only. We
// still catch: model responses are famously off-by-a-code-fence. Any
// parse failure returns null; the caller logs evaluator.error.
export function parseExtraction(raw: string): Extraction | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const j = JSON.parse(trimmed) as Partial<Extraction>;
    const people = Array.isArray(j.people) ? j.people.filter(
      (p): p is ExtractedPerson =>
        !!p && typeof p === "object" &&
        typeof (p as ExtractedPerson).handle === "string" &&
        typeof (p as ExtractedPerson).oneLine === "string" &&
        HANDLE_ALLOW.test((p as ExtractedPerson).handle),
    ) : [];
    const projects = Array.isArray(j.projects) ? j.projects.filter(
      (p): p is ExtractedProject =>
        !!p && typeof p === "object" &&
        typeof (p as ExtractedProject).key === "string" &&
        typeof (p as ExtractedProject).oneLine === "string" &&
        HANDLE_ALLOW.test((p as ExtractedProject).key),
    ) : [];
    const workspaceFacts = Array.isArray(j.workspaceFacts)
      ? j.workspaceFacts.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    return { people, projects, workspaceFacts };
  } catch {
    return null;
  }
}

export async function runEvaluator(
  input: EvaluatorInput,
  ctx: EvaluatorCtx,
): Promise<void> {
  const t0 = Date.now();
  try {
    const res = await chat(ctx.llm, [
      { role: "system", content: EVALUATOR_SYSTEM },
      { role: "user",   content: buildEvaluatorUserPrompt(input) },
    ], { json: true, temperature: 0.1, maxTokens: 400 });

    const extraction = parseExtraction(res.content);
    if (!extraction) {
      ctx.log.event("evaluator.error" as any, {
        error: "unparseable output",
        raw: res.content.slice(0, 300),
      });
      return;
    }

    if (ctx.dryRun) {
      ctx.log.event("evaluator.run" as any, {
        dryRun: true,
        model: ctx.llm.model,
        prompt_tokens: res.usage?.prompt_tokens ?? null,
        completion_tokens: res.usage?.completion_tokens ?? null,
        counts: {
          people: extraction.people.length,
          projects: extraction.projects.length,
          facts: extraction.workspaceFacts.length,
        },
        ms: Date.now() - t0,
      });
      return;
    }

    const peopleDir = join(ctx.entitiesDir, "people");
    const projectsDir = join(ctx.entitiesDir, "projects");
    const written = { created: 0, appended: 0, skippedCurated: 0, skippedDup: 0, notesAppended: 0, notesDeduped: 0 };

    for (const p of extraction.people) {
      const r = writeEntityFile(join(peopleDir, `${p.handle}.md`), p.oneLine);
      if (r.wrote === "created") written.created++;
      else if (r.wrote === "appended") written.appended++;
      else if (r.wrote === "skipped-curated") written.skippedCurated++;
      else if (r.wrote === "skipped-dup") written.skippedDup++;
    }
    for (const p of extraction.projects) {
      const r = writeEntityFile(join(projectsDir, `${p.key}.md`), p.oneLine);
      if (r.wrote === "created") written.created++;
      else if (r.wrote === "appended") written.appended++;
      else if (r.wrote === "skipped-curated") written.skippedCurated++;
      else if (r.wrote === "skipped-dup") written.skippedDup++;
    }

    // Dedup facts against the tail of notes.md — the same "AGNT team
    // retired" observation extracted five ticks in a row must not
    // spam the scratchpad. Cheap coarse substring check on the tail.
    const tail = tailNotesLower(ctx.notesPath);
    for (const fact of extraction.workspaceFacts) {
      const body = fact.trim().slice(0, 400);
      if (!body) continue;
      if (tail.includes(body.toLowerCase())) { written.notesDeduped++; continue; }
      appendNote(ctx.notesPath, body);
      written.notesAppended++;
    }

    ctx.log.event("evaluator.run" as any, {
      model: ctx.llm.model,
      prompt_tokens: res.usage?.prompt_tokens ?? null,
      completion_tokens: res.usage?.completion_tokens ?? null,
      extracted: {
        people: extraction.people.length,
        projects: extraction.projects.length,
        facts: extraction.workspaceFacts.length,
      },
      written,
      ms: Date.now() - t0,
    });
  } catch (err) {
    ctx.log.event("evaluator.error" as any, { error: String(err).slice(0, 300), ms: Date.now() - t0 });
  }
}
