import { describe, it, expect, afterEach } from "vitest";
import { startWakeServer } from "./wake.ts";
import type { Server } from "node:http";

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

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
});
