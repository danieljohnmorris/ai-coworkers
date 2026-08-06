// Coverage for the entity evaluator — extraction, writer semantics,
// dedup, curated-file safety, env-flag gate, and error handling.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runEvaluator,
  writeEntityFile,
  parseExtraction,
  buildEvaluatorUserPrompt,
  AUTO_HEADING,
} from "./evaluator.ts";
import { openEvents, Log } from "./log.ts";
import { openEntities } from "./entities.ts";
import type { Perception } from "./deliberate.ts";
import type { LLMConfig } from "./llm.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const llm: LLMConfig = { baseUrl: "http://fake", apiKey: "k", model: "cheap-eval" };

const perception = (): Perception => ({
  now: "2026-08-06T00:00:00.000Z",
  sensors: [{ name: "linear.new_issues", result: { issues: [{ id: "AIC-1", title: "hi" }] } }],
  recentActions: [], pendingPromises: [], resources: [], rollups: [],
  tempo: { callsToday: 0, callsPerHour: 0, noopRatioLast100: 1, secondsSinceLastPerceptionChange: 0 },
  budget: { callsToday: 0, dailyCap: 500, callsInWindow: 0, windowCap: 200, windowMinutes: 300 },
  tempoGuidance: "", highlightsTail: "", recentThoughts: "", inboxUnread: "", reactionsUnread: "", rateLimits: [],
});

function mockFetch(payload: object, opts: { status?: number } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify({
    choices: [{ message: { content: typeof payload === "string" ? payload : JSON.stringify(payload) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  });
  globalThis.fetch = (async () => new Response(body, { status: opts.status ?? 200 })) as typeof fetch;
}

function mockFetchRaw(rawContent: string) {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: rawContent } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }))) as typeof fetch;
}

function makeCtx() {
  const tmp = mkdtempSync(join(tmpdir(), "eval-test-"));
  const stateDir = join(tmp, "state");
  const entitiesDir = join(stateDir, "entities");
  mkdirSync(entitiesDir, { recursive: true });
  const events = openEvents(join(stateDir, "events.db"));
  const log = new Log(events, "test");
  const entities = openEntities(entitiesDir);
  const notesPath = join(stateDir, "notes.md");
  const eventKinds = () =>
    (events.prepare("SELECT kind, payload FROM events ORDER BY id").all() as { kind: string; payload: string }[])
      .map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload) }));
  return { tmp, stateDir, entitiesDir, notesPath, log, entities, events, eventKinds };
}

describe("parseExtraction", () => {
  it("parses well-formed JSON", () => {
    const e = parseExtraction('{"people":[{"handle":"dan","oneLine":"engineer"}],"projects":[],"workspaceFacts":[]}');
    expect(e?.people).toEqual([{ handle: "dan", oneLine: "engineer" }]);
  });

  it("strips code fences", () => {
    const e = parseExtraction('```json\n{"people":[],"projects":[],"workspaceFacts":["fact"]}\n```');
    expect(e?.workspaceFacts).toEqual(["fact"]);
  });

  it("filters malformed entries and bad handles", () => {
    const e = parseExtraction(JSON.stringify({
      people: [{ handle: "ok", oneLine: "a" }, { handle: "bad handle!", oneLine: "x" }, { handle: "nomeaning" }],
      projects: [{ key: "ilo", oneLine: "b" }, { nokey: true }],
      workspaceFacts: ["real", "", 42],
    }));
    expect(e?.people).toEqual([{ handle: "ok", oneLine: "a" }]);
    expect(e?.projects).toEqual([{ key: "ilo", oneLine: "b" }]);
    expect(e?.workspaceFacts).toEqual(["real"]);
  });

  it("returns null on unparseable JSON", () => {
    expect(parseExtraction("not json at all")).toBeNull();
  });
});

describe("writeEntityFile", () => {
  it("creates a new file with the auto-generated heading", () => {
    const t = mkdtempSync(join(tmpdir(), "wef-"));
    const p = join(t, "people", "dan.md");
    const r = writeEntityFile(p, "engineer at ilo");
    expect(r.wrote).toBe("created");
    const text = readFileSync(p, "utf8");
    expect(text.startsWith(AUTO_HEADING)).toBe(true);
    expect(text).toContain("engineer at ilo");
    rmSync(t, { recursive: true, force: true });
  });

  it("appends under existing auto-generated heading", () => {
    const t = mkdtempSync(join(tmpdir(), "wef-"));
    const p = join(t, "dan.md");
    writeFileSync(p, `${AUTO_HEADING}\nfirst line\n`);
    const r = writeEntityFile(p, "second line");
    expect(r.wrote).toBe("appended");
    const text = readFileSync(p, "utf8");
    expect(text).toContain("first line");
    expect(text).toContain("second line");
    rmSync(t, { recursive: true, force: true });
  });

  it("skips curated files (no auto-generated heading)", () => {
    const t = mkdtempSync(join(tmpdir(), "wef-"));
    const p = join(t, "dan.md");
    const curated = "# Dan\nHumans wrote this. Do not touch.\n";
    writeFileSync(p, curated);
    const r = writeEntityFile(p, "auto oneLine");
    expect(r.wrote).toBe("skipped-curated");
    expect(readFileSync(p, "utf8")).toBe(curated);
    rmSync(t, { recursive: true, force: true });
  });

  it("dedupes identical oneLines within an auto file", () => {
    const t = mkdtempSync(join(tmpdir(), "wef-"));
    const p = join(t, "dan.md");
    writeFileSync(p, `${AUTO_HEADING}\nsame line\n`);
    const r = writeEntityFile(p, "same line");
    expect(r.wrote).toBe("skipped-dup");
    rmSync(t, { recursive: true, force: true });
  });

  it("rejects empty oneLine", () => {
    const t = mkdtempSync(join(tmpdir(), "wef-"));
    const r = writeEntityFile(join(t, "x.md"), "   ");
    expect(r.wrote).toBe("skipped-invalid");
    rmSync(t, { recursive: true, force: true });
  });
});

describe("buildEvaluatorUserPrompt", () => {
  it("includes sensor, action, and thought sections", () => {
    const s = buildEvaluatorUserPrompt({
      perception: perception(),
      priorSteps: [{ tool: "save.thing", input: { x: 1 }, outcome: "ok" }],
      thoughts: "I noticed AIC-1",
    });
    expect(s).toContain("Sensors this tick");
    expect(s).toContain("linear.new_issues");
    expect(s).toContain("Actions this tick");
    expect(s).toContain("save.thing");
    expect(s).toContain("Recent thoughts");
    expect(s).toContain("I noticed AIC-1");
  });

  it("renders '(none)' when everything is empty", () => {
    const s = buildEvaluatorUserPrompt({
      perception: { ...perception(), sensors: [] },
      priorSteps: [],
      thoughts: "",
    });
    expect(s).toContain("Sensors this tick\n(none)");
    expect(s).toContain("Actions this tick\n(none)");
    expect(s).toContain("Recent thoughts\n(none)");
  });
});

describe("runEvaluator — writer paths", () => {
  let c: ReturnType<typeof makeCtx>;
  beforeEach(() => { c = makeCtx(); });
  afterEach(() => { rmSync(c.tmp, { recursive: true, force: true }); });

  it("creates a stub person file when none exists, appends a note", async () => {
    mockFetch({
      people: [{ handle: "dan", oneLine: "reviews PRs on ilo-lang/ilo" }],
      projects: [{ key: "ilo", oneLine: "core language repo" }],
      workspaceFacts: ["AGNT team is retired — do not attempt writes"],
    });
    await runEvaluator(
      { perception: perception(), priorSteps: [], thoughts: "" },
      { llm, entities: c.entities, entitiesDir: c.entitiesDir, notesPath: c.notesPath, log: c.log, dryRun: false },
    );

    const dan = readFileSync(join(c.entitiesDir, "people", "dan.md"), "utf8");
    expect(dan).toContain(AUTO_HEADING);
    expect(dan).toContain("reviews PRs");
    const ilo = readFileSync(join(c.entitiesDir, "projects", "ilo.md"), "utf8");
    expect(ilo).toContain("core language repo");
    const notes = readFileSync(c.notesPath, "utf8");
    expect(notes).toContain("[auto]");
    expect(notes).toContain("AGNT team is retired");

    const runs = c.eventKinds().filter((e) => e.kind === "evaluator.run");
    expect(runs.length).toBe(1);
    expect(runs[0].payload.written.created).toBe(2);
    expect(runs[0].payload.written.notesAppended).toBe(1);
  });

  it("does not touch a curated existing entity file", async () => {
    const danPath = join(c.entitiesDir, "people", "dan.md");
    mkdirSync(join(c.entitiesDir, "people"), { recursive: true });
    const curated = "# Dan\nHuman-owned prose only.\n";
    writeFileSync(danPath, curated);
    mockFetch({
      people: [{ handle: "dan", oneLine: "auto oneLine" }],
      projects: [],
      workspaceFacts: [],
    });
    await runEvaluator(
      { perception: perception(), priorSteps: [], thoughts: "" },
      { llm, entities: c.entities, entitiesDir: c.entitiesDir, notesPath: c.notesPath, log: c.log, dryRun: false },
    );
    expect(readFileSync(danPath, "utf8")).toBe(curated);
    const runs = c.eventKinds().filter((e) => e.kind === "evaluator.run");
    expect(runs[0].payload.written.skippedCurated).toBe(1);
  });

  it("appends under an existing auto-generated entity file without duplicating", async () => {
    const danPath = join(c.entitiesDir, "people", "dan.md");
    mkdirSync(join(c.entitiesDir, "people"), { recursive: true });
    writeFileSync(danPath, `${AUTO_HEADING}\nfirst fact\n`);
    mockFetch({
      people: [
        { handle: "dan", oneLine: "first fact" },     // dup
        { handle: "dan", oneLine: "second fact" },    // new
      ],
      projects: [],
      workspaceFacts: [],
    });
    await runEvaluator(
      { perception: perception(), priorSteps: [], thoughts: "" },
      { llm, entities: c.entities, entitiesDir: c.entitiesDir, notesPath: c.notesPath, log: c.log, dryRun: false },
    );
    const text = readFileSync(danPath, "utf8");
    expect(text).toContain("first fact");
    expect(text).toContain("second fact");
    // "first fact" appears exactly once.
    expect(text.match(/first fact/g)?.length).toBe(1);
  });

  it("dedupes workspace facts against the tail of notes.md", async () => {
    writeFileSync(c.notesPath, "\n## 2026-08-06T00:00:00.000Z  [auto]\nAGNT team is retired\n");
    mockFetch({
      people: [], projects: [],
      workspaceFacts: ["AGNT team is retired", "brand new fact about escalation channel"],
    });
    await runEvaluator(
      { perception: perception(), priorSteps: [], thoughts: "" },
      { llm, entities: c.entities, entitiesDir: c.entitiesDir, notesPath: c.notesPath, log: c.log, dryRun: false },
    );
    const notes = readFileSync(c.notesPath, "utf8");
    expect(notes.match(/AGNT team is retired/g)?.length).toBe(1);
    expect(notes).toContain("brand new fact about escalation channel");
    const runs = c.eventKinds().filter((e) => e.kind === "evaluator.run");
    expect(runs[0].payload.written.notesAppended).toBe(1);
    expect(runs[0].payload.written.notesDeduped).toBe(1);
  });

  it("dry-run logs counts and writes nothing", async () => {
    mockFetch({
      people: [{ handle: "dan", oneLine: "x" }],
      projects: [], workspaceFacts: ["fact"],
    });
    await runEvaluator(
      { perception: perception(), priorSteps: [], thoughts: "" },
      { llm, entities: c.entities, entitiesDir: c.entitiesDir, notesPath: c.notesPath, log: c.log, dryRun: true },
    );
    expect(existsSync(join(c.entitiesDir, "people", "dan.md"))).toBe(false);
    expect(existsSync(c.notesPath)).toBe(false);
    const runs = c.eventKinds().filter((e) => e.kind === "evaluator.run");
    expect(runs[0].payload.dryRun).toBe(true);
    expect(runs[0].payload.counts).toEqual({ people: 1, projects: 0, facts: 1 });
  });

  it("logs evaluator.error and does not crash on unparseable LLM output", async () => {
    mockFetchRaw("this is not json");
    await runEvaluator(
      { perception: perception(), priorSteps: [], thoughts: "" },
      { llm, entities: c.entities, entitiesDir: c.entitiesDir, notesPath: c.notesPath, log: c.log, dryRun: false },
    );
    const errs = c.eventKinds().filter((e) => e.kind === "evaluator.error");
    expect(errs.length).toBe(1);
    expect(errs[0].payload.error).toMatch(/unparseable/);
  });

  it("logs evaluator.error and swallows fetch failure", async () => {
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    await runEvaluator(
      { perception: perception(), priorSteps: [], thoughts: "" },
      { llm, entities: c.entities, entitiesDir: c.entitiesDir, notesPath: c.notesPath, log: c.log, dryRun: false },
    );
    const errs = c.eventKinds().filter((e) => e.kind === "evaluator.error");
    expect(errs.length).toBe(1);
    expect(errs[0].payload.error).toMatch(/network down/);
  });
});
