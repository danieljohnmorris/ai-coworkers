import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { slackPost, slackDM, slackMentions } from "./slack.ts";
import type { ToolCtx } from "../runtime/tools.ts";

const ctxDry = (env: Record<string, string> = {}): ToolCtx => ({
  coworker: "t", dryRun: true, env: env as NodeJS.ProcessEnv,
});
const ctxLive = (env: Record<string, string> = {}): ToolCtx => ({
  coworker: "t", dryRun: false, env: env as NodeJS.ProcessEnv,
});

let calls: string[];
const original = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("auth.test")) {
      return new Response(JSON.stringify({ ok: true, user_id: "UBOT" }));
    }
    if (u.includes("chat.postMessage")) {
      return new Response(JSON.stringify({ ok: true, ts: "1.0", channel: "C1" }));
    }
    if (u.includes("conversations.open")) {
      return new Response(JSON.stringify({ ok: true, channel: { id: "D1" } }));
    }
    if (u.includes("conversations.history")) {
      return new Response(JSON.stringify({
        ok: true,
        messages: [
          { user: "UDAN", text: "hey <@UBOT> ping", ts: "2.0" },
          { user: "UOTHER", text: "unrelated msg", ts: "3.0" },
        ],
      }));
    }
    return new Response(JSON.stringify({ ok: false, error: "unknown" }), { status: 404 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = original; });

describe("slackMentions", () => {
  it("warns without token", async () => {
    const r = await slackMentions.handler({}, ctxLive({})) as any;
    expect(r.warning).toMatch(/SLACK_BOT_TOKEN/);
  });
  it("warns without watched channels", async () => {
    const r = await slackMentions.handler({}, ctxLive({ SLACK_BOT_TOKEN: "x" })) as any;
    expect(r.warning).toMatch(/SLACK_WATCHED_CHANNELS/);
  });
  it("returns only messages mentioning the bot user id", async () => {
    const r = await slackMentions.handler({}, ctxLive({
      SLACK_BOT_TOKEN: "x", SLACK_WATCHED_CHANNELS: "C1",
    })) as any;
    expect(r.mentions.length).toBe(1);
    expect((r.mentions[0] as any).user).toBe("UDAN");
  });
});

describe("slackPost", () => {
  it("dry-run does not call fetch", async () => {
    const r = await slackPost.handler({ channel: "C1", text: "hi" }, ctxDry({ SLACK_BOT_TOKEN: "x" })) as any;
    expect(r.dryRun).toBe(true);
    expect(calls.length).toBe(0);
  });
  it("posts when live", async () => {
    const r = await slackPost.handler({ channel: "C1", text: "hi" }, ctxLive({ SLACK_BOT_TOKEN: "x" })) as any;
    expect(r.ts).toBe("1.0");
  });
  it("throws without token when live", async () => {
    await expect(slackPost.handler({ channel: "C1", text: "hi" }, ctxLive({}))).rejects.toThrow();
  });
});

describe("slackDM", () => {
  it("dry-run does not open conversation", async () => {
    const r = await slackDM.handler({ user: "UDAN", text: "hi" }, ctxDry({ SLACK_BOT_TOKEN: "x" })) as any;
    expect(r.dryRun).toBe(true);
    expect(calls.length).toBe(0);
  });
  it("opens DM channel then posts when live", async () => {
    const r = await slackDM.handler({ user: "UDAN", text: "hi" }, ctxLive({ SLACK_BOT_TOKEN: "x" })) as any;
    expect(r.channel).toBe("D1");
    expect(r.ts).toBe("1.0");
    expect(calls.some((c) => c.includes("conversations.open"))).toBe(true);
    expect(calls.some((c) => c.includes("chat.postMessage"))).toBe(true);
  });
});
