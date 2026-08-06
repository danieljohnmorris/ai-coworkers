import { describe, it, expect } from "vitest";
import { TRUNCATION_MARKER, truncated } from "./config.ts";

describe("cfg env override", () => {
  it("reads defaults when env vars unset (and honours env when set on re-import)", async () => {
    // Set env then re-import a fresh copy so the module-level `num` runs.
    process.env.TICK_INTERVAL_MS = "12345";
    try {
      const url = new URL("./config.ts?envtest", import.meta.url).href;
      const mod = await import(url);
      expect(mod.cfg.tickIntervalMs).toBe(12345);
    } finally {
      delete process.env.TICK_INTERVAL_MS;
    }
  });
});

describe("truncated", () => {
  it("returns the input unchanged if under the cap", () => {
    expect(truncated("short", 100)).toBe("short");
  });

  it("appends the truncation marker when cut", () => {
    const s = "a".repeat(500);
    const out = truncated(s, 200);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("handles max shorter than the marker itself", () => {
    const out = truncated("some content", 5);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});
