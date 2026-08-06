import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { roleProposeChange, rolePendingProposals } from "./role.ts";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolCtx } from "../runtime/tools.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const NAME = "__test_role__";
const BASE = join(REPO_ROOT, "coworkers", NAME);

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(join(BASE, "role"), { recursive: true });
  mkdirSync(join(BASE, "state"), { recursive: true });
  writeFileSync(join(BASE, "role", "AUTHORITY.md"), "May comment on tickets.\n");
});
afterEach(() => {
  rmSync(BASE, { recursive: true, force: true });
});

const ctx = (dryRun: boolean, env: Record<string, string> = {}): ToolCtx => ({
  coworker: NAME, dryRun, env: env as NodeJS.ProcessEnv,
});

const goodInput = {
  doc: "AUTHORITY",
  body: "May comment on tickets.\nMay set priority on dogfood tickets.",
  rationale: "Blocked repeatedly waiting on triage.",
};

describe("role.propose_change tool", () => {
  it("dry-run files nothing and notifies nobody", async () => {
    const r = await roleProposeChange.handler(goodInput, ctx(true)) as any;
    expect(r.dryRun).toBe(true);
    expect(existsSync(join(BASE, "state", "proposals"))).toBe(false);
    expect(existsSync(join(BASE, "state", "questions.md"))).toBe(false);
  });

  it("live filing writes the proposal and notifies the manager via questions.md", async () => {
    const r = await roleProposeChange.handler(goodInput, ctx(false)) as any;
    expect(r.accepted).toBe(true);
    expect(existsSync(r.path)).toBe(true);
    expect((r.notified as any).delivered).toBe("manager");
    const q = readFileSync(join(BASE, "state", "questions.md"), "utf8");
    expect(q).toContain("proposed a change to my AUTHORITY.md");
    expect(q).toContain(`bin/review-proposal.sh ${NAME} show ${r.id}`);
  });

  it("a rejected proposal does not notify", async () => {
    const r = await roleProposeChange.handler({ ...goodInput, rationale: "" }, ctx(false)) as any;
    expect(r.accepted).toBe(false);
    expect(r.notified).toBeUndefined();
    expect(existsSync(join(BASE, "state", "questions.md"))).toBe(false);
  });

  it("MANAGER_SLACK failure falls back to questions.md and still reports the filed proposal", async () => {
    // No SLACK_BOT_TOKEN → slack path throws → fallback to manager log.
    const r = await roleProposeChange.handler(goodInput, ctx(false, { MANAGER_SLACK: "#coworker-ops" })) as any;
    expect(r.accepted).toBe(true);
    expect((r.notified as any).delivered).toBe("manager");
    expect(existsSync(join(BASE, "state", "questions.md"))).toBe(true);
  });

  it("role.pending_proposals lists the filed proposal", async () => {
    await roleProposeChange.handler(goodInput, ctx(false));
    const r = await rolePendingProposals.handler({}, ctx(false)) as any;
    expect(r.count).toBe(1);
    expect(r.pending[0].doc).toBe("AUTHORITY");
  });
});
