import { describe, it, expect, afterEach } from "vitest";
import { chat } from "./llm.ts";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

describe("chat", () => {
  it("uses default temperature and maxTokens when opts omitted", async () => {
    let sentBody: any;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
    }) as typeof fetch;
    const r = await chat({ baseUrl: "http://x", model: "m" }, [{ role: "user", content: "q" }]);
    expect(r.content).toBe("hi");
    expect(sentBody.temperature).toBe(0.2);
    expect(sentBody.max_tokens).toBe(800);
  });

  it("returns empty string when the response has no choices", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [] }))) as typeof fetch;
    const r = await chat({ baseUrl: "http://x", model: "m" }, []);
    expect(r.content).toBe("");
  });
});
