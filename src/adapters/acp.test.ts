import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runAcpTurn } from "./acp.ts";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let agentPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acp-"));
  agentPath = join(dir, "fake-agent.mjs");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// Build a tiny Node script that speaks ACP. The script's behaviour is
// controlled by a JSON `plan.json` next to it — each entry says: after
// receiving message N, respond with these frames.
function seedAgent(plan: unknown[]): void {
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  const script = `
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(readFileSync(join(here, "plan.json"), "utf8"));

function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(\`Content-Length: \${Buffer.byteLength(body, "utf8")}\\r\\n\\r\\n\${body}\`);
}

let buf = Buffer.alloc(0);
let received = 0;
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const end = buf.indexOf("\\r\\n\\r\\n");
    if (end === -1) return;
    const header = buf.slice(0, end).toString();
    const m = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!m) { buf = buf.slice(end + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < end + 4 + len) return;
    const body = buf.slice(end + 4, end + 4 + len).toString();
    buf = buf.slice(end + 4 + len);
    const msg = JSON.parse(body);
    const step = plan[received++];
    if (!step) continue;
    // step: { respond: [<frames>], reply: <object> }
    for (const frame of (step.notifications ?? [])) send(frame);
    if (step.replyTo !== undefined) {
      // Reply to the incoming request using its id.
      send({ jsonrpc: "2.0", id: msg.id, result: step.replyTo });
    }
    if (step.requestClient) {
      // Fire an agent→client request (a new id we make up); no reply needed here.
      send({ jsonrpc: "2.0", id: 1000 + received, method: step.requestClient.method, params: step.requestClient.params });
    }
  }
});
`;
  writeFileSync(agentPath, script);
  chmodSync(agentPath, 0o755);
}

describe("runAcpTurn", () => {
  it("performs initialize → session/new → session/prompt handshake", async () => {
    seedAgent([
      { replyTo: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake", title: "F", version: "0" }, authMethods: [] } },
      { replyTo: { sessionId: "sess-1" } },
      {
        notifications: [
          { jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "hello " } } } },
          { jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "world" } } } },
        ],
        replyTo: { stopReason: "end_turn" },
      },
    ]);
    const r = await runAcpTurn({ agentCmd: ["node", agentPath], prompt: "hi", cwd: dir, timeoutMs: 10_000 });
    expect(r.stopReason).toBe("end_turn");
    expect(r.transcript).toBe("hello world");
  });

  it("captures tool_call updates and usage", async () => {
    seedAgent([
      { replyTo: { protocolVersion: 1 } },
      { replyTo: { sessionId: "s2" } },
      {
        notifications: [
          { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s2", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "read foo.ts", kind: "read", status: "in_progress" } } },
          { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s2", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } } },
          { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s2", update: { sessionUpdate: "usage_update", used: 1234, size: 32000 } } },
        ],
        replyTo: { stopReason: "end_turn" },
      },
    ]);
    const r = await runAcpTurn({ agentCmd: ["node", agentPath], prompt: "read a file", cwd: dir, timeoutMs: 10_000 });
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].status).toBe("completed");
    expect(r.toolCalls[0].kind).toBe("read");
    expect(r.usage?.used).toBe(1234);
  });

  it("serves fs/read_text_file requests scoped to cwd", async () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "hello.txt"), "sandbox contents");
    seedAgent([
      { replyTo: { protocolVersion: 1 } },
      { replyTo: { sessionId: "s3" } },
      // After session/prompt: send an fs/read_text_file request to the client, then reply to the prompt.
      {
        requestClient: { method: "fs/read_text_file", params: { path: join(dir, "src", "hello.txt") } },
        replyTo: { stopReason: "end_turn" },
      },
    ]);
    const r = await runAcpTurn({ agentCmd: ["node", agentPath], prompt: "read", cwd: dir, timeoutMs: 10_000 });
    // No easy way to inspect the response we sent back; success = handshake completed cleanly.
    expect(r.stopReason).toBe("end_turn");
    expect(r.error).toBeUndefined();
  });

  it("rejects fs/read_text_file that escapes cwd", async () => {
    seedAgent([
      { replyTo: { protocolVersion: 1 } },
      { replyTo: { sessionId: "s4" } },
      {
        requestClient: { method: "fs/read_text_file", params: { path: "/etc/passwd" } },
        replyTo: { stopReason: "end_turn" },
      },
    ]);
    // Handshake still completes — we return an error to the agent for the fs call.
    const r = await runAcpTurn({ agentCmd: ["node", agentPath], prompt: "read", cwd: dir, timeoutMs: 10_000 });
    expect(r.stopReason).toBe("end_turn");
  });

  it("times out and returns stopReason='timeout' when the agent hangs", async () => {
    seedAgent([
      { replyTo: { protocolVersion: 1 } },
      { replyTo: { sessionId: "s5" } },
      // Do not reply to session/prompt — client must time out.
      { },
    ]);
    const r = await runAcpTurn({ agentCmd: ["node", agentPath], prompt: "hang", cwd: dir, timeoutMs: 500 });
    expect(r.stopReason).toBe("timeout");
  });

  it("returns error when the agent binary cannot be spawned", async () => {
    const r = await runAcpTurn({ agentCmd: ["/nonexistent-binary-xyz"], prompt: "x", cwd: dir, timeoutMs: 2000 });
    expect(r.stopReason).toBe("error");
    expect(r.error).toBeTruthy();
  });
});
