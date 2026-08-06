// Tool-handler tests. Stub fetch to exercise github + memory.search
// without hitting real APIs. (Linear tools were removed in favour of
// the remote Linear MCP server — see CHANGELOG Unreleased.)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
