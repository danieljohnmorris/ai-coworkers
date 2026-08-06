// Slack tool. Uses a bot token (SLACK_BOT_TOKEN, xoxb-...) via Slack Web API.
// Sensor: unread mentions in the last N minutes. Actions: post to a channel,
// DM a user. Dry-run honours ctx.dryRun.
//
// Env:
//   SLACK_BOT_TOKEN=xoxb-...
//   SLACK_WATCHED_CHANNELS=C0123,C0456    (channel IDs; leave empty to watch @-mentions everywhere)

import type { ToolDef, ToolCtx } from "../runtime/tools.ts";

const SLACK = "https://slack.com/api";

async function slack<T>(method: string, token: string, body?: object, init?: RequestInit): Promise<T> {
  const isGet = !body && (!init || init.method === "GET" || !init.method);
  const url = isGet && body ? `${SLACK}/${method}?${new URLSearchParams(body as any)}` : `${SLACK}/${method}`;
  const res = await fetch(url, {
    method: init?.method ?? (body ? "POST" : "GET"),
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as any;
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error ?? res.status}`);
  return data as T;
}

export const slackMentions: ToolDef = {
  name: "slack.mentions",
  requiresCreds: ["SLACK_BOT_TOKEN"],
  kind: "sensor",
  description: "Recent @-mentions of the bot in watched channels. Use to notice when someone is asking you something.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_input, ctx: ToolCtx) => {
    const token = ctx.env.SLACK_BOT_TOKEN;
    if (!token) return { warning: "SLACK_BOT_TOKEN not set" };
    // search.messages requires user token — bot tokens don't have search.
    // Instead: list mentioned channels via conversations.history, filter by bot user id.
    const auth = await slack<{ user_id: string }>("auth.test", token);
    const channelsCsv = ctx.env.SLACK_WATCHED_CHANNELS ?? "";
    const channels = channelsCsv.split(",").map((s) => s.trim()).filter(Boolean);
    if (!channels.length) return { warning: "SLACK_WATCHED_CHANNELS not set" };
    const results: unknown[] = [];
    const cutoff = (Date.now() - 15 * 60_000) / 1000; // last 15 min
    for (const channel of channels) {
      try {
        const r = await slack<{ messages: { user: string; text: string; ts: string }[] }>(
          `conversations.history?channel=${channel}&oldest=${cutoff}&limit=20`, token
        );
        for (const m of r.messages ?? []) {
          if (m.text?.includes(`<@${auth.user_id}>`)) {
            results.push({ channel, user: m.user, text: m.text, ts: m.ts });
          }
        }
      } catch (err) {
        results.push({ channel, error: String(err) });
      }
    }
    return { mentions: results };
  },
};

export const slackPost: ToolDef = {
  name: "slack.post",
  requiresCreds: ["SLACK_BOT_TOKEN"],
  kind: "action",
  description: "Post a message to a Slack channel. Use for the morning triage summary or P0 escalations.",
  inputSchema: {
    type: "object",
    required: ["channel", "text"],
    properties: {
      channel: { type: "string", description: "Channel ID (C0...) or #name" },
      text: { type: "string", description: "Message body; supports basic mrkdwn" },
      thread_ts: { type: "string", description: "Optional: reply in a thread" },
    },
  },
  handler: async (input: { channel: string; text: string; thread_ts?: string }, ctx: ToolCtx) => {
    if (ctx.dryRun) return { dryRun: true, would: input };
    const token = ctx.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error("SLACK_BOT_TOKEN not set");
    const out = await slack<{ ts: string; channel: string }>("chat.postMessage", token, input);
    return { ts: out.ts, channel: out.channel };
  },
};

export const slackDM: ToolDef = {
  name: "slack.dm",
  requiresCreds: ["SLACK_BOT_TOKEN"],
  kind: "action",
  description: "Send a direct message to a Slack user by their user ID. Use for P0 escalations to your manager.",
  inputSchema: {
    type: "object",
    required: ["user", "text"],
    properties: {
      user: { type: "string", description: "Slack user ID (U0...)" },
      text: { type: "string" },
    },
  },
  handler: async (input: { user: string; text: string }, ctx: ToolCtx) => {
    if (ctx.dryRun) return { dryRun: true, would: input };
    const token = ctx.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error("SLACK_BOT_TOKEN not set");
    // Open a DM channel with the user, then post there.
    const conv = await slack<{ channel: { id: string } }>("conversations.open", token, { users: input.user });
    const out = await slack<{ ts: string }>("chat.postMessage", token, {
      channel: conv.channel.id, text: input.text,
    });
    return { ts: out.ts, channel: conv.channel.id };
  },
};

export const slackTools: ToolDef[] = [slackMentions, slackPost, slackDM];
