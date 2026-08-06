import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { wrapWithSandbox, _resetSandboxCacheForTests } from "./sandbox.ts";

const origPlatform = process.platform;
const origSandbox = process.env.AICW_SANDBOX;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  _resetSandboxCacheForTests();
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  if (origSandbox === undefined) delete process.env.AICW_SANDBOX;
  else process.env.AICW_SANDBOX = origSandbox;
});

describe("wrapWithSandbox", () => {
  it("AICW_SANDBOX=off returns argv unchanged with reason", () => {
    const r = wrapWithSandbox(["node", "acp"], { cwd: "/tmp", kind: "off" });
    expect(r.sandbox).toBe("none");
    expect(r.reason).toContain("off");
    expect(r.argv).toEqual(["node", "acp"]);
  });

  it("non-Linux platforms return no-sandbox regardless of AICW_SANDBOX", () => {
    setPlatform("darwin");
    const r = wrapWithSandbox(["node", "acp"], { cwd: "/tmp", kind: "auto" });
    expect(r.sandbox).toBe("none");
    expect(r.reason).toContain("darwin");
  });

  it("empty argv → no-sandbox with reason", () => {
    setPlatform("linux");
    const r = wrapWithSandbox([], { cwd: "/tmp" });
    expect(r.sandbox).toBe("none");
    expect(r.reason).toContain("empty");
  });

  it("on linux with bwrap explicitly requested but unavailable, falls back with a clear reason", () => {
    setPlatform("linux");
    // Force cache to "not available" without invoking `command -v bwrap`.
    // Do it by wrapping with a fake path in PATH so both checks return false.
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent-only";
    _resetSandboxCacheForTests();
    const r = wrapWithSandbox(["node", "acp"], { cwd: "/tmp", kind: "bwrap" });
    process.env.PATH = origPath;
    expect(r.sandbox).toBe("none");
    expect(r.reason).toMatch(/bwrap.*not installed/i);
  });

  it("when a sandbox tool IS available on linux, wraps argv (integration when bwrap exists)", () => {
    setPlatform("linux");
    _resetSandboxCacheForTests();
    // Only assert wrapping if the CI runner actually has bwrap installed;
    // otherwise skip. Keeps the test hermetic across environments.
    const r = wrapWithSandbox(["node", "acp"], { cwd: "/tmp", kind: "auto" });
    if (r.sandbox === "none") return; // no sandbox tool present — nothing to assert
    expect(["bwrap", "firejail"]).toContain(r.sandbox);
    expect(r.argv[0]).toBe(r.sandbox);
    expect(r.argv).toContain("node");
    expect(r.argv).toContain("acp");
    // The unwrapped command comes AFTER the sandbox wrapper's flags.
    const nodeIdx = r.argv.indexOf("node");
    expect(nodeIdx).toBeGreaterThan(0);
  });
});
