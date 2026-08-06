// GitHub tool. Uses a personal access token (GITHUB_TOKEN) — no OAuth flow.
// Sensor: list open PRs across watched repos. Actions: comment on a PR,
// request changes / approve. Dry-run honours the ctx.dryRun flag.
//
// Watched repos come from env WATCHED_REPOS as "owner/repo,owner/repo".

import type { ToolDef, ToolCtx } from "../runtime/tools.ts";

const GH = "https://api.github.com";

async function gh<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ai-coworkers",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

function watchedRepos(env: NodeJS.ProcessEnv): string[] {
  return (env.WATCHED_REPOS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export const githubOpenPRs: ToolDef = {
  name: "github.open_prs",
  requiresCreds: ["GITHUB_TOKEN"],
  kind: "sensor",
  description: "List open pull requests across WATCHED_REPOS. Useful for the PR-reviewer coworker archetype.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_input, ctx: ToolCtx) => {
    const token = ctx.env.GITHUB_TOKEN;
    if (!token) return { warning: "GITHUB_TOKEN not set" };
    const repos = watchedRepos(ctx.env);
    if (!repos.length) return { warning: "WATCHED_REPOS is empty" };
    const results: unknown[] = [];
    for (const r of repos) {
      try {
        const prs = await gh<Array<{ number: number; title: string; user: { login: string }; draft: boolean; html_url: string; created_at: string }>>(
          `/repos/${r}/pulls?state=open&per_page=20`,
          token
        );
        for (const p of prs) {
          if (p.draft) continue;
          results.push({ repo: r, number: p.number, title: p.title, author: p.user.login, url: p.html_url, created: p.created_at });
        }
      } catch (err) {
        results.push({ repo: r, error: String(err) });
      }
    }
    return { prs: results };
  },
};

export const githubPRComment: ToolDef = {
  name: "github.pr_comment",
  requiresCreds: ["GITHUB_TOKEN"],
  kind: "action",
  description: "Post an issue-level comment on a pull request.",
  inputSchema: {
    type: "object",
    required: ["repo", "number", "body"],
    properties: {
      repo: { type: "string", description: "owner/repo" },
      number: { type: "integer" },
      body: { type: "string", description: "Comment body in GitHub-flavoured markdown" },
    },
  },
  handler: async (input: { repo: string; number: number; body: string }, ctx: ToolCtx) => {
    if (ctx.dryRun) return { dryRun: true, would: input };
    const token = ctx.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN not set");
    const out = await gh<{ html_url: string; id: number }>(
      `/repos/${input.repo}/issues/${input.number}/comments`,
      token,
      { method: "POST", body: JSON.stringify({ body: input.body }) }
    );
    return { url: out.html_url, id: out.id };
  },
};

export const githubTools: ToolDef[] = [githubOpenPRs, githubPRComment];
