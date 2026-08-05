// Minimal LLM client. Talks to any OpenAI-compatible endpoint via fetch.
// Defaults to Ollama Cloud (OLLAMA_HOST + OLLAMA_API_KEY).
// Tool-calling is optional; for the first cut we ask the model to return JSON
// describing its chosen action, which is more portable across local models.

export interface LLMConfig {
  baseUrl: string;                 // e.g. https://ollama.com
  apiKey?: string;
  model: string;                   // e.g. "kimi-k2.7-code:cloud"
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResult {
  content: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export async function chat(
  cfg: LLMConfig,
  messages: LLMMessage[],
  opts: { json?: boolean; temperature?: number; maxTokens?: number } = {}
): Promise<LLMResult> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 800,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
    usage?: LLMResult["usage"];
  };
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    usage: data.usage,
  };
}
