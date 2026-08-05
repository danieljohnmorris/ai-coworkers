// AIC-49 — word-boundary matching in denylist.
import { describe, it, expect } from "vitest";
import { checkAction } from "./boundaries.ts";
import type { Role } from "./role.ts";
import type { ToolDef } from "./tools.ts";

function roleWith(boundaries: string): Role {
  return {
    name: "t", dir: "/tmp",
    docs: { ROLE: "", RESPONSIBILITIES: "", AUTHORITY: "", BOUNDARIES: boundaries, RITUALS: "", RELATIONSHIPS: "", TOOLS: "- linear", WORKSPACE: "" },
    systemPrompt: "", limits: {} as any, cadence: "adaptive",
  };
}
const tool: ToolDef = { name: "linear.comment", kind: "action", description: "", inputSchema: { type: "object" }, handler: async () => ({}) };
const ctx = { coworker: "t", dryRun: true, env: {} as NodeJS.ProcessEnv };

describe("boundaries word-boundary denylist (AIC-49)", () => {
  it("does NOT block a substring match", () => {
    const role = roleWith("## Must not touch\n- billing");
    const r = checkAction(role, tool, { body: "we have a billion users" }, ctx);
    expect(r.allowed).toBe(true);
  });
  it("DOES block a whole-word match", () => {
    const role = roleWith("## Must not touch\n- billing");
    const r = checkAction(role, tool, { body: "update billing rules" }, ctx);
    expect(r.allowed).toBe(false);
  });
  it("blocks match adjacent to punctuation", () => {
    const role = roleWith("## Must not touch\n- billing");
    const r = checkAction(role, tool, { body: "note about billing: fix" }, ctx);
    expect(r.allowed).toBe(false);
  });
  it("ignores tokens shorter than 3 chars to avoid over-blocking", () => {
    const role = roleWith("## Must not touch\n- x");
    const r = checkAction(role, tool, { body: "anything at all" }, ctx);
    expect(r.allowed).toBe(true);
  });
  it("escapes regex meta in forbidden targets", () => {
    const role = roleWith("## Must not touch\n- foo.bar");
    const r = checkAction(role, tool, { body: "touching foo.bar directly" }, ctx);
    expect(r.allowed).toBe(false);
    const r2 = checkAction(role, tool, { body: "unrelated foo!bar note" }, ctx);
    expect(r2.allowed).toBe(true);
  });
});
