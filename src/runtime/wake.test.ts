import { describe, it, expect, afterEach } from "vitest";
import { startWakeServer } from "./wake.ts";
import { openEvents } from "./log.ts";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: Server | null = null;
let scratchDirs: string[] = [];
afterEach(() => {
  server?.close(); server = null;
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  scratchDirs = [];
});

async function pick(): Promise<number> {
  // Ask the OS for an ephemeral port.
  const s = (await import("node:net")).createServer();
  return new Promise((r) => s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as any).port; s.close(() => r(p));
  }));
}

describe("wake endpoint", () => {
  it("sets the flag on POST /wake", async () => {
    const port = await pick();
    const flag = { flag: false };
    server = startWakeServer(port, flag);
    const res = await fetch(`http://127.0.0.1:${port}/wake`, { method: "POST" });
    expect(res.ok).toBe(true);
    expect(flag.flag).toBe(true);
  });

  it("404s other paths", async () => {
    const port = await pick();
    server = startWakeServer(port, { flag: false });
    const res = await fetch(`http://127.0.0.1:${port}/other`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("401s without secret when one is required", async () => {
    const port = await pick();
    const flag = { flag: false };
    server = startWakeServer(port, flag, "s3cret");
    const bad = await fetch(`http://127.0.0.1:${port}/wake`, { method: "POST" });
    expect(bad.status).toBe(401);
    expect(flag.flag).toBe(false);
    const good = await fetch(`http://127.0.0.1:${port}/wake`, {
      method: "POST", headers: { "x-wake-secret": "s3cret" },
    });
    expect(good.status).toBe(200);
    expect(flag.flag).toBe(true);
  });

  it("serves Prometheus /metrics when enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wake-metrics-")); scratchDirs.push(dir);
    const events = openEvents(join(dir, "e.db"));
    events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), "alex", "tick.start", "{}");
    const port = await pick();
    server = startWakeServer(port, { flag: false }, { events, coworkerName: "alex", metricsEnabled: true });
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toContain("aicoworker_events_last_hour");
    expect(body).toContain('coworker="alex"');
  });

  it("dispatches a signed webhook via WEBHOOKS.json spec and fires wake + invalidate", async () => {
    const port = await pick();
    const flag = { flag: false };
    const invalidated: string[] = [];
    const { createHmac } = await import("node:crypto");
    const spec = {
      name: "linear",
      path: "/webhook/linear",
      auth: { type: "hmac-sha256" as const, header: "linear-signature", secretEnv: "MY_WH" },
      filter: { jsonPath: "data.team.key", allow: ["X"] },
      onEvent: { wake: true, invalidate: ["linear.new_issues"] },
    };
    server = startWakeServer(port, flag, {
      webhooks: [spec],
      env: { MY_WH: "wh-secret" },
      onSensorInvalidate: (n) => invalidated.push(n),
    });
    const body = JSON.stringify({ action: "create", type: "Issue", data: { team: { key: "X" } } });
    const sig = createHmac("sha256", "wh-secret").update(body).digest("hex");
    const res = await fetch(`http://127.0.0.1:${port}/webhook/linear`, {
      method: "POST",
      headers: { "linear-signature": sig, "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect(flag.flag).toBe(true);
    expect(invalidated).toEqual(["linear.new_issues"]);
  });

  it("binds 0.0.0.0 when webhooks are configured (reachable via non-loopback interface)", async () => {
    const port = await pick();
    server = startWakeServer(port, { flag: false }, {
      webhooks: [{
        name: "x", path: "/webhook/x",
        auth: { type: "none" as const },
        onEvent: { wake: true },
      }],
      env: {},
    });
    await new Promise<void>((r) => server!.once("listening", () => r()));
    const addr = server.address();
    expect(typeof addr === "object" && addr && "address" in addr && addr.address === "0.0.0.0").toBe(true);
  });

  it("returns 503 on /metrics when disabled", async () => {
    const port = await pick();
    server = startWakeServer(port, { flag: false });
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(503);
  });
});
