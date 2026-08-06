import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isCredentialName, filterEnvForTool, loadCoworkerEnv } from "./credentials.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("loadCoworkerEnv", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cwenv-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns baseEnv unchanged when no .env file exists", () => {
    const base = { LINEAR_API_KEY: "shell-key", HOME: "/h" } as NodeJS.ProcessEnv;
    mkdirSync(join(dir, "alice"), { recursive: true });
    const out = loadCoworkerEnv(dir, "alice", base);
    expect(out.LINEAR_API_KEY).toBe("shell-key");
    expect(out).not.toBe(base); // shallow copy, not aliased
  });

  it("overlays coworker .env on top of baseEnv (coworker wins)", () => {
    mkdirSync(join(dir, "alex-triage"), { recursive: true });
    writeFileSync(join(dir, "alex-triage", ".env"), "LINEAR_API_KEY=cubitts-key\nTICK_INTERVAL_MS=60000\n");
    const base = { LINEAR_API_KEY: "shell-key", OLLAMA_HOST: "https://x" } as NodeJS.ProcessEnv;
    const out = loadCoworkerEnv(dir, "alex-triage", base);
    expect(out.LINEAR_API_KEY).toBe("cubitts-key");     // coworker overrides shell
    expect(out.TICK_INTERVAL_MS).toBe("60000");         // new key added
    expect(out.OLLAMA_HOST).toBe("https://x");          // untouched shell var
  });

  it("skips blank lines and # comments", () => {
    mkdirSync(join(dir, "c"), { recursive: true });
    writeFileSync(join(dir, "c", ".env"), "# a comment\n\nKEY=value\n  # indented comment\n");
    const out = loadCoworkerEnv(dir, "c", {} as NodeJS.ProcessEnv);
    expect(out.KEY).toBe("value");
  });

  it("preserves values verbatim (no quote stripping, allows = in values)", () => {
    mkdirSync(join(dir, "c"), { recursive: true });
    writeFileSync(join(dir, "c", ".env"), 'A="quoted"\nB=has=equals\nC=\n');
    const out = loadCoworkerEnv(dir, "c", {} as NodeJS.ProcessEnv);
    expect(out.A).toBe('"quoted"');   // quotes are part of the value
    expect(out.B).toBe("has=equals"); // only the FIRST = splits
    expect(out.C).toBe("");           // empty value is allowed
  });

  it("skips malformed lines (no =, or leading =)", () => {
    mkdirSync(join(dir, "c"), { recursive: true });
    writeFileSync(join(dir, "c", ".env"), "no-equals-here\n=leading-equals\nGOOD=ok\n");
    const out = loadCoworkerEnv(dir, "c", {} as NodeJS.ProcessEnv);
    expect(out.GOOD).toBe("ok");
    expect(Object.keys(out).filter((k) => k)).toEqual(["GOOD"]);
  });

  it("two coworkers get independent envs from the same coworkersDir", () => {
    mkdirSync(join(dir, "alex"), { recursive: true });
    mkdirSync(join(dir, "bob"), { recursive: true });
    writeFileSync(join(dir, "alex", ".env"), "LINEAR_API_KEY=cubitts");
    writeFileSync(join(dir, "bob", ".env"), "LINEAR_API_KEY=dan-personal");
    const base = {} as NodeJS.ProcessEnv;
    expect(loadCoworkerEnv(dir, "alex", base).LINEAR_API_KEY).toBe("cubitts");
    expect(loadCoworkerEnv(dir, "bob", base).LINEAR_API_KEY).toBe("dan-personal");
    // Shell env untouched by either call.
    expect(base.LINEAR_API_KEY).toBeUndefined();
  });
});

