import { describe, it, expect } from "vitest";
import { TRUNCATION_MARKER, truncated } from "./config.ts";

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
