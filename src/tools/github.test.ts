import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { githubOpenPRs, githubPRComment } from "./github.ts";
import type { ToolCtx } from "../runtime/tools.ts";

const ctxLive = (env: Record<string, string> = {}): ToolCtx => ({
  coworker: "t", dryRun: false, env: env as NodeJS.ProcessEnv,
});

const original = globalThis.fetch;

afterEach(() => { globalThis.fetch = original; });

describe("githubOpenPRs", () => {
  it("warns without token", async () => {
    const r = await githubOpenPRs.handler({}, ctxLive({})) as any;
    expect(r.warning).toMatch(/GITHUB_TOKEN/);
  });

  it("warns when WATCHED_REPOS is empty", async () => {
    const r = await githubOpenPRs.handler({}, ctxLive({ GITHUB_TOKEN: "t" })) as any;
    expect(r.warning).toMatch(/WATCHED_REPOS/);
  });

  it("pr_comment dry-run returns intended payload without fetch", async () => {
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return new Response("{}"); }) as typeof fetch;
    const r = await githubPRComment.handler({ repo: "o/r", number: 1, body: "hi" }, { coworker: "t", dryRun: true, env: {} as any }) as any;
    expect(r.dryRun).toBe(true);
    expect(fetched).toBe(false);
  });

  it("pr_comment throws without token when live", async () => {
    await expect(githubPRComment.handler(
      { repo: "o/r", number: 1, body: "hi" },
      { coworker: "t", dryRun: false, env: {} as any },
    )).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it("aggregates PRs, skips drafts, and records per-repo errors", async () => {
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/repos/o/good/pulls")) {
        return new Response(JSON.stringify([
          { number: 1, title: "real", user: { login: "dan" }, draft: false, html_url: "u1", created_at: "t1" },
          { number: 2, title: "wip", user: { login: "dan" }, draft: true, html_url: "u2", created_at: "t2" },
        ]));
      }
      if (u.includes("/repos/o/bad/pulls")) {
        return new Response("boom", { status: 500 });
      }
      return new Response("{}");
    }) as typeof fetch;
    const r = await githubOpenPRs.handler({}, ctxLive({
      GITHUB_TOKEN: "t", WATCHED_REPOS: "o/good,o/bad",
    })) as any;
    const nonError = r.prs.filter((p: any) => !p.error);
    const errored = r.prs.filter((p: any) => p.error);
    expect(nonError.length).toBe(1);
    expect(nonError[0].number).toBe(1);
    expect(errored.length).toBe(1);
    expect(errored[0].repo).toBe("o/bad");
  });
});
