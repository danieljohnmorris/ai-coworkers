// Tool-handler tests. Stub fetch to exercise linear + github + memory.search
// without hitting real APIs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { linearNewIssues, linearComment, linearWorkspaceSnapshot } from "./linear.ts";
import { githubOpenPRs, githubPRComment } from "./github.ts";
import type { ToolCtx } from "../runtime/tools.ts";

const ctxLive = (env: Record<string, string> = {}): ToolCtx => ({
  coworker: "t", dryRun: false, env: env as NodeJS.ProcessEnv,
});
const ctxDry = (env: Record<string, string> = {}): ToolCtx => ({
  coworker: "t", dryRun: true, env: env as NodeJS.ProcessEnv,
});

let calls: Array<{ url: string; init?: RequestInit }>;
const original = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    // Route by URL
    const u = String(url);
    if (u.includes("api.linear.app")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.query.includes("workspace_snapshot") || body.query.includes("issueLabels")) {
        return new Response(JSON.stringify({
          data: {
            organization: { name: "T", urlKey: "t" },
            teams: { nodes: [{ key: "AIC", name: "ai-coworkers", description: "" }] },
            projects: { nodes: [] },
            issueLabels: { nodes: [{ name: "bug", color: "#f00" }] },
          },
        }));
      }
      if (body.query.includes("commentCreate")) {
        return new Response(JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "c1", url: "https://linear.app/c/1" } } } }));
      }
      return new Response(JSON.stringify({ data: { issues: { nodes: [{ id: "u1", identifier: "AIC-1", title: "x", priority: 0, createdAt: "", team: { key: "AIC", name: "t" }, state: { name: "Backlog" }, creator: { name: "Dan" } }] } } }));
    }
    if (u.includes("api.github.com")) {
      if (u.includes("/comments") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: 42, html_url: "https://github.com/x/y/pull/1#c42" }));
      }
      return new Response(JSON.stringify([
        { number: 1, title: "x", user: { login: "dan" }, draft: false, html_url: "u", created_at: "" },
        { number: 2, title: "draft", user: { login: "dan" }, draft: true, html_url: "u", created_at: "" },
      ]));
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = original; });

describe("linearNewIssues", () => {
  it("warns if key missing", async () => {
    const r = await linearNewIssues.handler({}, ctxLive({})) as any;
    expect(r.warning).toMatch(/LINEAR_API_KEY/);
  });
  it("returns nodes when key present", async () => {
    const r = await linearNewIssues.handler({}, ctxLive({ LINEAR_API_KEY: "k" })) as any;
    expect(r.issues.length).toBe(1);
    expect(calls[0].url).toContain("linear.app");
  });
});

describe("linearComment", () => {
  it("returns dryRun proposal without calling fetch", async () => {
    const r = await linearComment.handler({ issueId: "x", body: "y" }, ctxDry({ LINEAR_API_KEY: "k" })) as any;
    expect(r.dryRun).toBe(true);
    expect(calls.length).toBe(0);
  });
  it("posts when live", async () => {
    const r = await linearComment.handler({ issueId: "x", body: "y" }, ctxLive({ LINEAR_API_KEY: "k" })) as any;
    expect(r.success).toBe(true);
    expect(r.comment.id).toBe("c1");
  });
  it("throws when key missing in live mode", async () => {
    await expect(linearComment.handler({ issueId: "x", body: "y" }, ctxLive({}))).rejects.toThrow();
  });
});

describe("linearWorkspaceSnapshot", () => {
  it("returns shape summary", async () => {
    const r = await linearWorkspaceSnapshot.handler({}, ctxLive({ LINEAR_API_KEY: "k" })) as any;
    expect(r.organization.name).toBe("T");
    expect(r.labels).toContain("bug");
  });
});

describe("githubOpenPRs", () => {
  it("warns if token missing", async () => {
    const r = await githubOpenPRs.handler({}, ctxLive({})) as any;
    expect(r.warning).toMatch(/GITHUB_TOKEN/);
  });
  it("warns if no watched repos", async () => {
    const r = await githubOpenPRs.handler({}, ctxLive({ GITHUB_TOKEN: "t" })) as any;
    expect(r.warning).toMatch(/WATCHED_REPOS/);
  });
  it("lists non-draft PRs across repos", async () => {
    const r = await githubOpenPRs.handler({}, ctxLive({ GITHUB_TOKEN: "t", WATCHED_REPOS: "a/b" })) as any;
    expect(r.prs.length).toBe(1);
    expect((r.prs[0] as any).number).toBe(1);
  });
});

describe("githubPRComment", () => {
  it("dry-run does not call fetch", async () => {
    const r = await githubPRComment.handler({ repo: "a/b", number: 1, body: "x" }, ctxDry({ GITHUB_TOKEN: "t" })) as any;
    expect(r.dryRun).toBe(true);
    expect(calls.length).toBe(0);
  });
  it("posts when live", async () => {
    const r = await githubPRComment.handler({ repo: "a/b", number: 1, body: "x" }, ctxLive({ GITHUB_TOKEN: "t" })) as any;
    expect(r.id).toBe(42);
  });
});
