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

export const linearTools: ToolDef[] = [linearNewIssues, linearComment];
