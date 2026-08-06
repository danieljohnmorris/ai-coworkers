import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compactOutcome } from "./compact.ts";
import type { LLMConfig } from "./llm.ts";

const llm: LLMConfig = { baseUrl: "https://fake.local", model: "test", apiKey: "k" };
const original = globalThis.fetch;

function respond(content: string) {
  return async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

afterEach(() => {
  globalThis.fetch = original;
});

describe("compactOutcome", () => {
  it("returns raw JSON when under the threshold", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    const out = await compactOutcome(llm, { a: 1 }, 6000);
    expect(out).toBe('{"a":1}');
    expect(called).toBe(false);
  });

  it("summarises large outcomes and prefixes with [COMPACTED …]", async () => {
    globalThis.fetch = respond("short summary") as typeof fetch;
    const big = { blob: "x".repeat(7000) };
    const out = await compactOutcome(llm, big, 6000);
    expect(out.startsWith("[COMPACTED —")).toBe(true);
    expect(out).toContain("short summary");
  });

  it("caches by content hash — second call skips the LLM", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "sum" } }] }),
      );
    }) as typeof fetch;
    const big = { blob: "y".repeat(7000) };
    const first = await compactOutcome(llm, big, 6000);
    const second = await compactOutcome(llm, big, 6000);
    expect(first).toBe(second);
    expect(calls).toBe(1);
  });

  it("evicts oldest entries when the cache exceeds its cap", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: `s${calls}` } }] }));
    }) as typeof fetch;
    for (let i = 0; i < 205; i++) {
      await compactOutcome(llm, { i, pad: "q".repeat(7000) }, 6000);
    }
    // The very first entry should have been evicted; recomputing it triggers a fresh LLM call.
    const before = calls;
    await compactOutcome(llm, { i: 0, pad: "q".repeat(7000) }, 6000);
    expect(calls).toBeGreaterThan(before);
  });

  it("falls back to plain truncation when the LLM throws", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const big = { blob: "z".repeat(7000) };
    const out = await compactOutcome(llm, big, 6000);
    expect(out).toContain("truncated, compaction failed");
    expect(out.length).toBeLessThan(6100);
  });
});
