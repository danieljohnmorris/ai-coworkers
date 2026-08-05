// Coverage for the newer linear tools: untagged_issues, search,
// issue_detail, team_labels, set_labels.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  linearUntaggedIssues, linearSearchIssues,
  linearIssueDetail, linearTeamLabels, linearSetLabels,
} from "./linear.ts";
import type { ToolCtx } from "../runtime/tools.ts";

const ctxDry = (env: Record<string, string> = {}): ToolCtx => ({
  coworker: "t", dryRun: true, env: env as NodeJS.ProcessEnv,
});
const ctxLive = (env: Record<string, string> = {}): ToolCtx => ({
  coworker: "t", dryRun: false, env: env as NodeJS.ProcessEnv,
});

const original = globalThis.fetch;
let calls: { url: string; body: any }[];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: String(url), body });
    const q = String(body.query ?? "");
    if (q.includes("issueUpdate")) {
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true, issue: { identifier: "ILO-1", url: "u", labels: { nodes: [{ name: "parser" }] } } } } }));
    }
    if (q.includes("team(") && q.includes("labels")) {
      return new Response(JSON.stringify({ data: { team: { id: "T1", name: "ILO", labels: { nodes: [{ id: "L1", name: "parser", color: "#f00" }] } } } }));
    }
    if (q.includes("issue(id")) {
      return new Response(JSON.stringify({ data: { issue: { id: "u1", identifier: "ILO-1", title: "parser bug", labels: { nodes: [] }, team: { key: "ILO", name: "ILO" }, state: { name: "Backlog", type: "backlog" } } } }));
    }
    if (q.includes("searchableContent") || q.includes("$filter")) {
      return new Response(JSON.stringify({ data: { issues: { nodes: [{ identifier: "ILO-1", title: "match" }] } } }));
    }
    // untagged: paginated query
    return new Response(JSON.stringify({
      data: {
        issues: {
          nodes: [
            { id: "u1", identifier: "ILO-1", title: "no labels", team: { key: "ILO" }, state: { type: "backlog" }, labels: { nodes: [] } },
            { id: "u2", identifier: "CS-1", title: "ignored team", team: { key: "CS" }, state: { type: "backlog" }, labels: { nodes: [] } },
            { id: "u3", identifier: "ILO-2", title: "already tagged", team: { key: "ILO" }, state: { type: "backlog" }, labels: { nodes: [{ id: "L1", name: "parser" }] } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }));
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = original; });

describe("linearUntaggedIssues", () => {
  it("warns without key", async () => {
    const r = await linearUntaggedIssues.handler({}, ctxLive({})) as any;
    expect(r.warning).toMatch(/LINEAR_API_KEY/);
  });
  it("filters to open + untagged, honours LINEAR_IGNORE_TEAMS, reports totals", async () => {
    const r = await linearUntaggedIssues.handler({}, ctxLive({
      LINEAR_API_KEY: "k", LINEAR_IGNORE_TEAMS: "CS,CR",
    })) as any;
    expect(r.totalUntagged).toBe(1);        // only ILO-1 (CS ignored, ILO-2 already tagged)
    expect(r.byTeam.ILO).toBe(1);
    expect(r.byTeam.CS).toBeUndefined();
    expect((r.issues[0] as any).identifier).toBe("ILO-1");
  });
});

describe("linearSearchIssues", () => {
  it("returns matching issues", async () => {
    const r = await linearSearchIssues.handler({ query: "parser" }, ctxLive({ LINEAR_API_KEY: "k" })) as any;
    expect(r.count).toBe(1);
    expect((r.issues[0] as any).identifier).toBe("ILO-1");
  });
  it("passes team filter when provided", async () => {
    await linearSearchIssues.handler({ query: "parser", teamKey: "ILO" }, ctxLive({ LINEAR_API_KEY: "k" }));
    const last = calls[calls.length - 1];
    expect(String(last.body.query)).toContain("$filter");
  });
});

describe("linearIssueDetail", () => {
  it("uses $identifier variable matching the input key", async () => {
    const r = await linearIssueDetail.handler({ identifier: "ILO-1" }, ctxLive({ LINEAR_API_KEY: "k" })) as any;
    expect(r.issue.identifier).toBe("ILO-1");
    const last = calls[calls.length - 1];
    expect(last.body.variables).toEqual({ identifier: "ILO-1" });
  });
  it("warns without key", async () => {
    const r = await linearIssueDetail.handler({ identifier: "X" }, ctxLive({})) as any;
    expect(r.warning).toMatch(/LINEAR_API_KEY/);
  });
});

describe("linearTeamLabels", () => {
  it("uses $teamKey variable matching input", async () => {
    const r = await linearTeamLabels.handler({ teamKey: "ILO" }, ctxLive({ LINEAR_API_KEY: "k" })) as any;
    expect(r.teamId).toBe("T1");
    expect(r.labels[0].name).toBe("parser");
    const last = calls[calls.length - 1];
    expect(last.body.variables).toEqual({ teamKey: "ILO" });
  });
});

describe("linearSetLabels", () => {
  it("dry-run does not fetch", async () => {
    const r = await linearSetLabels.handler({ issueId: "u1", labelIds: ["L1"] }, ctxDry({ LINEAR_API_KEY: "k" })) as any;
    expect(r.dryRun).toBe(true);
    expect(calls.length).toBe(0);
  });
  it("mutates with $issueId variable matching input", async () => {
    const r = await linearSetLabels.handler({ issueId: "u1", labelIds: ["L1"] }, ctxLive({ LINEAR_API_KEY: "k" })) as any;
    expect(r.success).toBe(true);
    const last = calls[calls.length - 1];
    expect(last.body.variables).toEqual({ issueId: "u1", labelIds: ["L1"] });
    expect(String(last.body.query)).toContain("$issueId");
  });
});
