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
  kind: "sensor",
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
      query ($id: String!) {
        issue(id: $id) {
          id identifier title description priority updatedAt
          team { key name }
          state { name type }
          labels { nodes { id name } }
          creator { name }
        }
      }`;
    const data = await gql<{ issue: unknown }>(q, { id: input.identifier }, key);
    return { issue: data.issue };
  },
};

export const linearTeamLabels: ToolDef = {
  name: "linear.team_labels",
  kind: "sensor",
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
      query ($k: String!) {
        team(id: $k) { id name labels(first: 100) { nodes { id name color } } }
      }`;
    const data = await gql<{ team: { id: string; labels: { nodes: { id: string; name: string }[] } } | null }>(
      q, { k: input.teamKey }, key
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
    const m = `
      mutation ($id: String!, $labelIds: [String!]!) {
        issueUpdate(id: $id, input: { labelIds: $labelIds }) {
          success issue { identifier url labels { nodes { name } } }
        }
      }`;
    const data = await gql<{ issueUpdate: { success: boolean; issue: unknown } }>(m, input, key);
    return data.issueUpdate;
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
  linearComment,
  linearWorkspaceSnapshot,
  linearIssueDetail,
  linearTeamLabels,
  linearSetLabels,
];
