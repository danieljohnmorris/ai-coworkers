import { describe, it, expect } from "vitest";
import { isCredentialName, filterEnvForTool } from "./credentials.ts";

describe("isCredentialName", () => {
  it("matches common token/key/secret suffixes", () => {
    expect(isCredentialName("SLACK_BOT_TOKEN")).toBe(true);
    expect(isCredentialName("LINEAR_API_KEY")).toBe(true);
    expect(isCredentialName("GITHUB_TOKEN")).toBe(true);
    expect(isCredentialName("STRIPE_SECRET")).toBe(true);
    expect(isCredentialName("DB_PASSWORD")).toBe(true);
    expect(isCredentialName("SSH_PRIVATE_KEY")).toBe(true);
    expect(isCredentialName("OPENAI_API_KEY")).toBe(true);
    expect(isCredentialName("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(isCredentialName("GH_PAT")).toBe(true);
  });
  it("leaves ordinary vars alone", () => {
    expect(isCredentialName("HOME")).toBe(false);
    expect(isCredentialName("PATH")).toBe(false);
    expect(isCredentialName("NODE_ENV")).toBe(false);
    expect(isCredentialName("MCP_SERVERS")).toBe(false); // config, not credential
    expect(isCredentialName("SLACK_WATCHED_CHANNELS")).toBe(false); // config
  });
});

describe("filterEnvForTool", () => {
  const env = {
    HOME: "/home/dan",
    PATH: "/usr/bin",
    LINEAR_API_KEY: "lin_x",
    SLACK_BOT_TOKEN: "xoxb_x",
    GITHUB_TOKEN: "ghp_x",
    OPENAI_API_KEY: "sk_x",
  } as NodeJS.ProcessEnv;

  it("passes the full env through when the tool has not declared requiresCreds (backwards compat)", () => {
    expect(filterEnvForTool(env, undefined)).toEqual(env);
  });

  it("strips every credential when the tool declared []", () => {
    const filtered = filterEnvForTool(env, []);
    expect(filtered.HOME).toBe("/home/dan");
    expect(filtered.PATH).toBe("/usr/bin");
    expect(filtered.LINEAR_API_KEY).toBeUndefined();
    expect(filtered.SLACK_BOT_TOKEN).toBeUndefined();
    expect(filtered.GITHUB_TOKEN).toBeUndefined();
    expect(filtered.OPENAI_API_KEY).toBeUndefined();
  });

  it("keeps only declared credentials, blocks everything else even if related", () => {
    const filtered = filterEnvForTool(env, ["LINEAR_API_KEY"]);
    expect(filtered.LINEAR_API_KEY).toBe("lin_x");
    expect(filtered.SLACK_BOT_TOKEN).toBeUndefined();
    expect(filtered.GITHUB_TOKEN).toBeUndefined();
    expect(filtered.OPENAI_API_KEY).toBeUndefined();
    // Non-credentials still pass.
    expect(filtered.HOME).toBe("/home/dan");
  });
});
