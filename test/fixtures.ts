// Fake LLM + fake Linear so tick() can be exercised end-to-end in tests
// without touching Ollama or Linear's API.

import type { LLMConfig } from "../src/runtime/llm.ts";

// If a test wants to fake the LLM, it can stub `global.fetch` to route
// /v1/chat/completions to this responder. Keeps things dep-free.
export interface StubbedLLM {
  respondWith(json: unknown): void;                  // enqueue one response
  respondWithSequence(items: unknown[]): void;       // enqueue several in order
  respondWithError(status: number, body: string): void;
  reset(): void;
  llm: LLMConfig;
}

export function stubLLM(): StubbedLLM {
  const queue: { status: number; body: unknown }[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/v1/chat/completions") && queue.length) {
      const { status, body } = queue.shift()!;
      const payload = status === 200
        ? JSON.stringify({ choices: [{ message: { content: typeof body === "string" ? body : JSON.stringify(body) } }] })
        : String(body);
      return new Response(payload, { status, headers: { "Content-Type": "application/json" } });
    }
    // No queued response — return a "done" noop so tests don't hang.
    if (String(url).includes("/v1/chat/completions")) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"action":"noop","reason":"done"}' } }],
      }), { status: 200 });
    }
    return original(url as any, init);
  }) as typeof fetch;

  return {
    llm: { baseUrl: "http://fake-llm", model: "fake" },
    respondWith(json) { queue.push({ status: 200, body: json }); },
    respondWithSequence(items) { for (const i of items) queue.push({ status: 200, body: i }); },
    respondWithError(status, body) { queue.push({ status, body }); },
    reset() { globalThis.fetch = original; queue.length = 0; },
  };
}
