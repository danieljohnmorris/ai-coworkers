import { describe, it, expect } from "vitest";
import { gmailSearch, gmailSend, resolveQuery, DEFAULT_SENSOR_QUERY } from "./gmail.ts";
import type { ToolCtx } from "../runtime/tools.ts";

const ctxDry = (): ToolCtx => ({ coworker: "__gmail_smoke__", dryRun: true, env: process.env });
const ctxLive = (): ToolCtx => ({ coworker: "__gmail_smoke__", dryRun: false, env: process.env });

describe("gmail tools — fail-soft when not configured", () => {
  it("gmail.send dry-run does not touch disk or spawn python", async () => {
    const r = await gmailSend.handler({ to: "x@y", subject: "hi", body: "b" }, ctxDry()) as any;
    expect(r.dryRun).toBe(true);
    expect(r.would.to).toBe("x@y");
  });

  it("gmail.search returns a warning when the coworker hasn't been set up", async () => {
    const r = await gmailSearch.handler({ query: "is:unread" }, ctxLive()) as any;
    // Either Hermes skill missing OR token missing — both should surface as a warning.
    expect(typeof r.warning).toBe("string");
    expect(r.warning).toMatch(/setup-gmail|not installed|not configured/i);
  });

  it("gmail.search called with no args (the tick sensor path) still warns, never crashes", async () => {
    const r = await gmailSearch.handler({}, ctxLive()) as any;
    expect(typeof r.warning).toBe("string");
  });
});

describe("resolveQuery", () => {
  it("prefers an explicit query", () => {
    expect(resolveQuery("from:a@b", { GMAIL_SENSOR_QUERY: "is:starred" })).toBe("from:a@b");
  });

  it("falls back to GMAIL_SENSOR_QUERY when called with no query (sensor path)", () => {
    expect(resolveQuery(undefined, { GMAIL_SENSOR_QUERY: "is:starred" })).toBe("is:starred");
  });

  it("falls back to the built-in default when neither is set", () => {
    expect(resolveQuery(undefined, {})).toBe(DEFAULT_SENSOR_QUERY);
    expect(resolveQuery(undefined, undefined)).toBe(DEFAULT_SENSOR_QUERY);
  });

  it("treats whitespace-only values as absent", () => {
    expect(resolveQuery("   ", { GMAIL_SENSOR_QUERY: "  " })).toBe(DEFAULT_SENSOR_QUERY);
  });
});
