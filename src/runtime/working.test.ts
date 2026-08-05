import { describe, it, expect } from "vitest";
import { compactRecentActions, truncateSensorPayloads } from "./working.ts";

describe("compactRecentActions", () => {
  it("passes through when under budget", () => {
    const items = [{ a: 1 }, { a: 2 }];
    const r = compactRecentActions(items, 1000);
    expect(r.compact).toEqual(items);
    expect(r.dropped).toBe(0);
  });

  it("keeps the newest items and reports dropped count", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ i, payload: "x".repeat(50) }));
    const r = compactRecentActions(items, 500);
    expect(r.compact.length).toBeLessThan(100);
    expect(r.dropped).toBeGreaterThan(0);
    // Newest kept: the last item is present
    expect(r.compact[r.compact.length - 1]).toEqual(items[items.length - 1]);
  });
});

describe("truncateSensorPayloads", () => {
  it("leaves small payloads unchanged", () => {
    const s = [{ name: "a", result: { x: 1 } }];
    expect(truncateSensorPayloads(s)).toEqual(s);
  });

  it("truncates large payloads with metadata", () => {
    const big = "x".repeat(10_000);
    const s = [{ name: "a", result: { big } }];
    const out = truncateSensorPayloads(s, 100);
    expect((out[0].result as any)._truncated).toBe(true);
    expect((out[0].result as any).preview.length).toBeLessThan(200);
  });
});
