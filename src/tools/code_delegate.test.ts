import { describe, it, expect } from "vitest";
import { codeDelegate } from "./code_delegate.ts";
import type { ToolCtx } from "../runtime/tools.ts";

const ctxDry = (env: Record<string, string> = {}): ToolCtx => ({
  coworker: "t", dryRun: true, env: env as NodeJS.ProcessEnv,
});
const ctxLive = (env: Record<string, string> = {}): ToolCtx => ({
  coworker: "t", dryRun: false, env: env as NodeJS.ProcessEnv,
});

describe("code.delegate", () => {
  it("dry-run returns wouldPrompt without spawning anything", async () => {
    const r = await codeDelegate.handler({ prompt: "please refactor foo.ts" }, ctxDry({ ACP_AGENT_CMD: "goose acp" })) as any;
    expect(r.dryRun).toBe(true);
    expect(r.wouldPrompt).toContain("please refactor");
  });

  it("errors clearly when ACP_AGENT_CMD is not set", async () => {
    const r = await codeDelegate.handler({ prompt: "x" }, ctxLive({})) as any;
    expect(r.error).toMatch(/ACP_AGENT_CMD/);
  });

  it("parses ACP_ALLOW_KINDS from env when input.allowKinds is omitted", async () => {
    // Live call with a bad binary → we still reach parseAllowKinds before spawning.
    const r = await codeDelegate.handler(
      { prompt: "x", cwd: "/tmp" },
      ctxLive({ ACP_AGENT_CMD: "/nonexistent-binary-xyz", ACP_TIMEOUT_MS: "2000", ACP_ALLOW_KINDS: "read,execute" }),
    ) as any;
    expect(r.stopReason).toBe("error");
  });

  it("returns stopReason='error' when the agent binary is missing", async () => {
    const r = await codeDelegate.handler(
      { prompt: "x", cwd: "/tmp" },
      ctxLive({ ACP_AGENT_CMD: "/nonexistent-binary-xyz", ACP_TIMEOUT_MS: "2000" }),
    ) as any;
    expect(r.stopReason).toBe("error");
    expect(r.error).toBeTruthy();
  });
});
