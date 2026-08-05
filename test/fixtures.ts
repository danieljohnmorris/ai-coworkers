// Fake LLM + fake Linear so tick() can be exercised end-to-end in tests
// without touching Ollama or Linear's API.

import type { LLMConfig } from "../src/runtime/llm.ts";

// If a test wants to fake the LLM, it can stub `global.fetch` to route
// /v1/chat/completions to this responder. Keeps things dep-free.
export interface StubbedLLM {
  respondWith(json: unknown): void;
  respondWithError(status: number, body: string): void;
  reset(): void;
  llm: LLMConfig;
}

export function stubLLM(): StubbedLLM {
  let next: { status: number; body: unknown } | null = null;
  const original = globalThis.fetch;

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/v1/chat/completions") && next) {
      const { status, body } = next;
      next = null;
      const payload = status === 200
        ? JSON.stringify({ choices: [{ message: { content: typeof body === "string" ? body : JSON.stringify(body) } }] })
        : String(body);
      return new Response(payload, { status, headers: { "Content-Type": "application/json" } });
    }
    return original(url as any, init);
  }) as typeof fetch;

  return {
    llm: { baseUrl: "http://fake-llm", model: "fake" },
    respondWith(json) { next = { status: 200, body: json }; },
    respondWithError(status, body) { next = { status, body }; },
    reset() { globalThis.fetch = original; next = null; },
  };
}
