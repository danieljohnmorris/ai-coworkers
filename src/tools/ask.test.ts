import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ask, unansweredQuestions } from "./ask.ts";
import { mkdirSync, rmSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolCtx } from "../runtime/tools.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const NAME = "__test_ask__";
const PEER = "__test_peer__";

beforeEach(() => {
  rmSync(join(REPO_ROOT, "coworkers", NAME), { recursive: true, force: true });
  rmSync(join(REPO_ROOT, "coworkers", PEER), { recursive: true, force: true });
  mkdirSync(join(REPO_ROOT, "coworkers", NAME, "state"), { recursive: true });
  mkdirSync(join(REPO_ROOT, "coworkers", PEER, "state"), { recursive: true });
});
afterEach(() => {
  rmSync(join(REPO_ROOT, "coworkers", NAME), { recursive: true, force: true });
  rmSync(join(REPO_ROOT, "coworkers", PEER), { recursive: true, force: true });
});

const ctxLive = (env: Record<string, string> = {}): ToolCtx => ({
  coworker: NAME, dryRun: false, env: env as NodeJS.ProcessEnv,
});
const ctxDry = (env: Record<string, string> = {}): ToolCtx => ({
  coworker: NAME, dryRun: true, env: env as NodeJS.ProcessEnv,
});

describe("ask tool", () => {
  it("dry-run does not write", async () => {
    const r = await ask.handler({ to: "manager", question: "?" }, ctxDry()) as any;
    expect(r.dryRun).toBe(true);
    expect(existsSync(join(REPO_ROOT, "coworkers", NAME, "state", "questions.md"))).toBe(false);
  });

  it("to=manager appends to questions.md as unanswered", async () => {
    const r = await ask.handler({ to: "manager", question: "should I split ILO-42?", context: "big ticket" }, ctxLive()) as any;
    expect(r.delivered).toBe("manager");
    const body = readFileSync(r.path, "utf8");
    expect(body).toContain("**Q:** should I split ILO-42?");
    expect(body).toContain("**Context:** big ticket");
    expect(body).toMatch(/\*\*A:\*\*\s*_?\(?unanswered\)?_?/);
  });

  it("unansweredQuestions returns only unanswered blocks", async () => {
    await ask.handler({ to: "manager", question: "Q1" }, ctxLive());
    await ask.handler({ to: "manager", question: "Q2" }, ctxLive());
    // Manually mark Q1 answered
    const path = join(REPO_ROOT, "coworkers", NAME, "state", "questions.md");
    let text = readFileSync(path, "utf8");
    text = text.replace(/\*\*A:\*\*\s*_\(unanswered\)_/, "**A:** yes");
    // Overwrite
    require("node:fs").writeFileSync(path, text);
    const un = unansweredQuestions(NAME);
    expect(un).toContain("Q2");
    expect(un).not.toContain("Q1");
  });

  it("to=coworker: appends to peer's inbox", async () => {
    const r = await ask.handler({ to: `coworker:${PEER}`, question: "handover?" }, ctxLive()) as any;
    expect(r.delivered).toBe(`coworker:${PEER}`);
    const inbox = readFileSync(join(REPO_ROOT, "coworkers", PEER, "state", "inbox.md"), "utf8");
    expect(inbox).toContain(`from ${NAME}`);
    expect(inbox).toContain("handover?");
  });

  it("to=coworker: rejects unknown peer", async () => {
    const r = await ask.handler({ to: "coworker:nonexistent-xyz", question: "?" }, ctxLive()) as any;
    expect(r.error).toMatch(/no coworker/);
  });

  it("unknown recipient prefix returns an error", async () => {
    const r = await ask.handler({ to: "weird:xyz", question: "?" }, ctxLive()) as any;
    expect(r.error).toMatch(/unknown recipient/);
  });

  it("to=github: with malformed spec errors", async () => {
    const r = await ask.handler({ to: "github:no-hash", question: "?" }, ctxLive({ GITHUB_TOKEN: "t" })) as any;
    expect(r.error).toMatch(/bad github spec/);
  });
});

describe("unansweredQuestions when file missing", () => {
  it("returns empty string", () => {
    expect(unansweredQuestions("nonexistent-coworker")).toBe("");
  });
});
