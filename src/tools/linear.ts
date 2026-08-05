// Linear tools. First cut: one sensor (new/untriaged issues) and one action
// (comment on an issue). Action honours dryRun by returning the intended
// GraphQL mutation without sending it.
//
// Requires LINEAR_API_KEY in env. Uses Linear's GraphQL API directly to avoid
// adding a dep for the first cut.

import type { ToolDef, ToolCtx } from "../runtime/tools.ts";

const LINEAR_API = "https://api.linear.app/graphql";

async function gql<T>(query: string, variables: Record<string, unknown>, apiKey: string): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { data?: T; errors?: unknown };
  if (data.errors) throw new Error(`Linear errors: ${JSON.stringify(data.errors)}`);
  return data.data!;
}

export const linearNewIssues: ToolDef = {
  name: "linear.new_issues",
  kind: "sensor",
  description: "List recently created Linear issues that are untriaged (no priority set).",
  inputSchema: { type: "object", properties: {} },
  handler: async (_input, ctx: ToolCtx) => {
    const key = ctx.env.LINEAR_API_KEY;
    if (!key) return { issues: [], warning: "LINEAR_API_KEY not set" };
    const q = `
      query {
        issues(
          first: 20,
          filter: { priority: { eq: 0 } },
          orderBy: createdAt
        ) {
          nodes {
            id identifier title priority createdAt
            team { key name }
            state { name }
            creator { name }
          }
        }
      }`;
    const data = await gql<{ issues: { nodes: unknown[] } }>(q, {}, key);
    return { issues: data.issues.nodes };
  },
};

export const linearUntaggedIssues: ToolDef = {
  name: "linear.untagged_issues",
  kind: "sensor",
  description: "Open Linear issues in watched teams that currently have no labels. Feed the label-maintenance responsibility. Respects team ignore list via LINEAR_IGNORE_TEAMS env (comma-separated team keys).",
  inputSchema: { type: "object", properties: {} },
  handler: async (_input, ctx: ToolCtx) => {
    const key = ctx.env.LINEAR_API_KEY;
    if (!key) return { issues: [], warning: "LINEAR_API_KEY not set" };
    const ignore = new Set((ctx.env.LINEAR_IGNORE_TEAMS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    // Fetch across multiple pages so older untagged backlog isn't missed.
    // Filter server-side by state (open) and client-side by "no labels".
    const collected: any[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page++) {                     // up to 5 * 100 = 500 issues
      const q = `
        query ($after: String) {
          issues(
            first: 100, after: $after,
            filter: { state: { type: { in: ["backlog","unstarted","started"] } } },
            orderBy: createdAt
          ) {
            nodes {
              id identifier title priority updatedAt
              team { key name }
              state { name type }
              labels { nodes { id name } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`;
      const data = await gql<{ issues: { nodes: any[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
        q, { after }, key
      );
      collected.push(...data.issues.nodes);
      if (!data.issues.pageInfo.hasNextPage) break;
      after = data.issues.pageInfo.endCursor;
    }
    const untagged = collected.filter((i) =>
      (i.labels?.nodes?.length ?? 0) === 0 && !ignore.has(i.team.key)
    );
    return {
      totalUntagged: untagged.length,
      issues: untagged.slice(0, 15),      // send 15 to the model per tick
      byTeam: countByKey(untagged, (i) => i.team.key),
    };
  },
};

function countByKey<T>(arr: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of arr) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export const linearComment: ToolDef = {
  name: "linear.comment",
  kind: "action",
  description: "Post a comment on a Linear issue. Use to propose triage decisions or ask reporter for info.",
  inputSchema: {
    type: "object",
    required: ["issueId", "body"],
    properties: {
      issueId: { type: "string", description: "Linear issue id (uuid) or identifier like INGEST-42" },
      body: { type: "string", description: "Comment body in markdown" },
    },
  },
  handler: async (input: { issueId: string; body: string }, ctx: ToolCtx) => {
    if (ctx.dryRun) {
      return { dryRun: true, wouldComment: input };
    }
    const key = ctx.env.LINEAR_API_KEY;
    if (!key) throw new Error("LINEAR_API_KEY not set");
    const m = `
      mutation ($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id url }
        }
      }`;
    const data = await gql<{ commentCreate: { success: boolean; comment: { id: string; url: string } } }>(
      m,
      input,
      key
    );
    return data.commentCreate;
  },
};

export const linearIssueDetail: ToolDef = {
  name: "linear.issue_detail",
  // Read-only but requires input; sensors are called with no args by the
  // tick loop, so this is exposed as an "action" the model calls when it
  // needs context on a specific issue. Never side-effects — safe under
  // dry-run.
  kind: "action",
  description: "Fetch full detail of a Linear issue including current labels and description. Use before deciding what labels to set.",
  inputSchema: {
    type: "object",
    required: ["identifier"],
    properties: { identifier: { type: "string", description: "e.g. ILO-509 or the UUID" } },
  },
  handler: async (input: { identifier: string }, ctx: ToolCtx) => {
    const key = ctx.env.LINEAR_API_KEY;
    if (!key) return { warning: "LINEAR_API_KEY not set" };
    const q = `
      query ($identifier: String!) {
        issue(id: $identifier) {
          id identifier title description priority updatedAt
          team { key name }
          state { name type }
          labels { nodes { id name } }
          creator { name }
        }
      }`;
    const data = await gql<{ issue: unknown }>(q, input, key);
    return { issue: data.issue };
  },
};

export const linearSearchIssues: ToolDef = {
  name: "linear.search",
  kind: "action",
  description: "Search Linear issues by keyword and/or team. Use when you need to find issues beyond what sensors surface — e.g. re-check an older ticket, cross-reference by keyword, or scan a specific team.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text search (title + description)" },
      teamKey: { type: "string", description: "Optional team filter e.g. ILO" },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    },
  },
  handler: async (input: { query?: string; teamKey?: string; limit?: number }, ctx: ToolCtx) => {
    const key = ctx.env.LINEAR_API_KEY;
    if (!key) return { warning: "LINEAR_API_KEY not set" };
    const filter: Record<string, unknown> = {};
    if (input.query) filter.searchableContent = { contains: input.query };
    if (input.teamKey) filter.team = { key: { eq: input.teamKey } };
    const q = `
      query ($filter: IssueFilter, $limit: Int!) {
        issues(filter: $filter, first: $limit, orderBy: updatedAt) {
          nodes {
            id identifier title priority updatedAt
            team { key name }
            state { name type }
            labels { nodes { name } }
          }
        }
      }`;
    const data = await gql<{ issues: { nodes: unknown[] } }>(
      q, { filter, limit: input.limit ?? 20 }, key
    );
    return { count: data.issues.nodes.length, issues: data.issues.nodes };
  },
};

export const linearTeamLabels: ToolDef = {
  name: "linear.team_labels",
  // Read-only but takes input; see note on linearIssueDetail. Exposed as an
  // action so the model can call it with a team key.
  kind: "action",
  description: "List all label ids and names available in a team. Cached daily. Use to know which labels exist before proposing.",
  inputSchema: {
    type: "object",
    required: ["teamKey"],
    properties: { teamKey: { type: "string", description: "team key e.g. ILO" } },
  },
  handler: async (input: { teamKey: string }, ctx: ToolCtx) => {
    const key = ctx.env.LINEAR_API_KEY;
    if (!key) return { warning: "LINEAR_API_KEY not set" };
    const q = `
      query ($teamKey: String!) {
        team(id: $teamKey) { id name labels(first: 100) { nodes { id name color } } }
      }`;
    const data = await gql<{ team: { id: string; labels: { nodes: { id: string; name: string }[] } } | null }>(
      q, input, key
    );
    if (!data.team) return { warning: `team ${input.teamKey} not found` };
    return { teamId: data.team.id, labels: data.team.labels.nodes };
  },
};

export const linearSetLabels: ToolDef = {
  name: "linear.set_labels",
  kind: "action",
  description: "Set the labels on a Linear issue (replaces existing set). Pass label IDs, not names — resolve names via linear.team_labels first.",
  inputSchema: {
    type: "object",
    required: ["issueId", "labelIds"],
    properties: {
      issueId: { type: "string", description: "Linear issue id (uuid) or identifier like ILO-509" },
      labelIds: { type: "array", items: { type: "string" }, description: "Full set of label IDs to apply" },
    },
  },
  handler: async (input: { issueId: string; labelIds: string[] }, ctx: ToolCtx) => {
    if (ctx.dryRun) return { dryRun: true, wouldSet: input };
    const key = ctx.env.LINEAR_API_KEY;
    if (!key) throw new Error("LINEAR_API_KEY not set");
    // GraphQL variable names must match the object keys we pass to gql().
    // We pass `input` as-is → declare $issueId and $labelIds accordingly.
    const m = `
      mutation ($issueId: String!, $labelIds: [String!]!) {
        issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
          success issue { identifier url labels { nodes { name } } }
        }
      }`;
    const data = await gql<{ issueUpdate: { success: boolean; issue: unknown } }>(m, input, key);
    return data.issueUpdate;
  },
};

export const linearCreateLabel: ToolDef = {
  name: "linear.create_label",
  kind: "action",
  description:
    "Create a NEW label in a team's vocabulary. Use ONLY when reusing an existing label is genuinely wrong AND your manager has approved (ask via `ask` to='manager' first if in doubt). Prefer the smallest label vocabulary possible; overuse creates label sprawl.",
  inputSchema: {
    type: "object",
    required: ["teamId", "name"],
    properties: {
      teamId: { type: "string", description: "Team UUID (from linear.team_labels or workspace_snapshot)" },
      name: { type: "string", description: "Label name — short, lowercase, no spaces preferred" },
      color: { type: "string", description: "Hex colour like '#F0A020'" },
      description: { type: "string" },
    },
  },
  handler: async (input: { teamId: string; name: string; color?: string; description?: string }, ctx: ToolCtx) => {
    if (ctx.dryRun) return { dryRun: true, wouldCreate: input };
    const key = ctx.env.LINEAR_API_KEY;
    if (!key) throw new Error("LINEAR_API_KEY not set");
    const m = `
      mutation ($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name color }
        }
      }`;
    const data = await gql<{ issueLabelCreate: { success: boolean; issueLabel: { id: string; name: string; color: string } } }>(
      m,
      { input: { teamId: input.teamId, name: input.name, color: input.color, description: input.description } },
      key
    );
    return data.issueLabelCreate;
  },
};

export const linearWorkspaceSnapshot: ToolDef = {
  name: "linear.workspace_snapshot",
  kind: "sensor",
  description:
    "Once/day snapshot of workspace shape: teams, active projects, label frequency, priority distribution. Gives the coworker structural awareness without hand-authored WORKSPACE.md having to enumerate everything.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_input, ctx) => {
    const key = ctx.env.LINEAR_API_KEY;
    if (!key) return { warning: "LINEAR_API_KEY not set" };
    const q = `
      query {
        organization { name urlKey }
        teams(first: 25) { nodes { key name description } }
        projects(first: 25) { nodes { name state url teams { nodes { key } } } }
        issueLabels(first: 50) { nodes { name color } }
      }`;
    const data = await gql<{
      organization: { name: string; urlKey: string };
      teams: { nodes: unknown[] };
      projects: { nodes: unknown[] };
      issueLabels: { nodes: { name: string; color: string }[] };
    }>(q, {}, key);
    return {
      organization: data.organization,
      teams: data.teams.nodes,
      projects: data.projects.nodes,
      labels: data.issueLabels.nodes.map((l) => l.name),
    };
  },
};

export const linearTools: ToolDef[] = [
  linearNewIssues,
  linearUntaggedIssues,
  linearComment,
  linearWorkspaceSnapshot,
  linearIssueDetail,
  linearTeamLabels,
  linearSetLabels,
  linearSearchIssues,
  linearCreateLabel,
];
