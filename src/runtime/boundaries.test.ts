import { describe, it, expect } from "vitest";
import { checkAction } from "./boundaries.ts";
import type { Role } from "./role.ts";
import type { ToolDef } from "./tools.ts";

function roleWith(docs: Partial<Role["docs"]>): Role {
  const empty = { ROLE: "", RESPONSIBILITIES: "", AUTHORITY: "", BOUNDARIES: "", RITUALS: "", RELATIONSHIPS: "", TOOLS: "", WORKSPACE: "" };
  return {
    name: "t",
    dir: "/tmp",
    docs: { ...empty, ...docs },
    systemPrompt: "",
    limits: { maxWorktrees: 5, maxWorktreeAgeHours: 24, maxDiskMB: 5120, killSubprocessIdleMin: 30 },
  };
}

const tool: ToolDef = {
  name: "linear.comment",
  kind: "action",
  description: "",
  inputSchema: { type: "object" },
  handler: async () => ({}),
};
const ctx = { coworker: "t", dryRun: true, env: {} as NodeJS.ProcessEnv };

describe("checkAction", () => {
  it("denies a tool not listed in TOOLS.md", () => {
    const r = checkAction(roleWith({ TOOLS: "- slack" }), tool, {}, ctx);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not declared in TOOLS/);
  });

  it("allows a tool declared by exact prefix", () => {
    const r = checkAction(roleWith({ TOOLS: "- linear: read + comment" }), tool, {}, ctx);
    expect(r.allowed).toBe(true);
  });

  it("allows a tool declared by full name", () => {
    const r = checkAction(roleWith({ TOOLS: "- linear.comment: comment" }), tool, {}, ctx);
    expect(r.allowed).toBe(true);
  });

  it("blocks input mentioning a forbidden target from BOUNDARIES", () => {
    const role = roleWith({
      TOOLS: "- linear",
      BOUNDARIES: "## Must not touch\n- personal\n- billing",
    });
    const r = checkAction(role, tool, { issueId: "CS-1", body: "quick note about personal accounts" }, ctx);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/forbidden target/);
  });

  it("allows input that does not mention forbidden targets", () => {
    const role = roleWith({
      TOOLS: "- linear",
      BOUNDARIES: "## Must not touch\n- personal\n- billing",
    });
    const r = checkAction(role, tool, { issueId: "ILO-1", body: "proposing P2" }, ctx);
    expect(r.allowed).toBe(true);
  });
});
