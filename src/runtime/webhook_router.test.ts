import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { dispatchWebhook, handleWebhookRequest } from "./webhook_router.ts";
import type { WebhookSpec } from "./webhooks_loader.ts";

const linear: WebhookSpec = {
  name: "linear",
  path: "/webhook/linear",
  auth: { type: "hmac-sha256", header: "linear-signature", secretEnv: "MY_SECRET" },
  filter: { jsonPath: "data.team.key", allow: ["ILO"] },
  onEvent: { wake: true, invalidate: ["linear.new_issues"] },
};

const body = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8");
const sign = (b: Buffer, k: string) => createHmac("sha256", k).update(b).digest("hex");

describe("dispatchWebhook", () => {
  it("200 wakes + invalidates when signature ok and filter matches", () => {
    const b = body({ data: { team: { key: "ILO" } } });
    const wakes: string[] = [];
    const inv: string[] = [];
    const r = dispatchWebhook(b, { "linear-signature": sign(b, "s") }, linear, {
      onWake: (r) => wakes.push(r),
      invalidateSensor: (n) => inv.push(n),
    }, { MY_SECRET: "s" });
    expect(r.status).toBe(200);
    expect(wakes[0]).toBe("webhook:linear");
    expect(inv).toEqual(["linear.new_issues"]);
  });

  it("202 when filter does not match", () => {
    const b = body({ data: { team: { key: "OTHER" } } });
    const wakes: string[] = [];
    const r = dispatchWebhook(b, { "linear-signature": sign(b, "s") }, linear, {
      onWake: (r) => wakes.push(r),
    }, { MY_SECRET: "s" });
    expect(r.status).toBe(202);
    expect(wakes).toEqual([]);
  });

  it("202 when filtered path resolves to non-string", () => {
    const b = body({ data: { team: {} } });
    const r = dispatchWebhook(b, { "linear-signature": sign(b, "s") }, linear, { onWake: () => {} }, { MY_SECRET: "s" });
    expect(r.status).toBe(202);
  });

  it("202 when walkPath hits a non-object mid-path", () => {
    const spec: WebhookSpec = { ...linear, filter: { jsonPath: "a.b.c", allow: ["z"] } };
    const b = body({ a: "not-an-object" });
    const r = dispatchWebhook(b, { "linear-signature": sign(b, "s") }, spec, { onWake: () => {} }, { MY_SECRET: "s" });
    expect(r.status).toBe(202);
  });

  it("401 on bad signature", () => {
    const b = body({ data: { team: { key: "ILO" } } });
    const r = dispatchWebhook(b, { "linear-signature": "0".repeat(64) }, linear, { onWake: () => {} }, { MY_SECRET: "s" });
    expect(r.status).toBe(401);
  });

  it("503 when secretEnv unset", () => {
    const b = body({});
    const r = dispatchWebhook(b, {}, linear, { onWake: () => {} }, {});
    expect(r.status).toBe(503);
  });

  it("400 on well-signed but invalid JSON when filter present", () => {
    const b = Buffer.from("{not json", "utf8");
    const r = dispatchWebhook(b, { "linear-signature": sign(b, "s") }, linear, { onWake: () => {} }, { MY_SECRET: "s" });
    expect(r.status).toBe(400);
  });

  it("accepts all payloads when no filter is set", () => {
    const spec: WebhookSpec = { ...linear, filter: undefined };
    const b = body({ anything: 1 });
    const wakes: string[] = [];
    const r = dispatchWebhook(b, { "linear-signature": sign(b, "s") }, spec, { onWake: (r) => wakes.push(r) }, { MY_SECRET: "s" });
    expect(r.status).toBe(200);
    expect(wakes).toHaveLength(1);
  });

  it("skips wake when onEvent.wake is false", () => {
    const spec: WebhookSpec = { ...linear, filter: undefined, onEvent: { wake: false } };
    const b = body({});
    const wakes: string[] = [];
    const r = dispatchWebhook(b, { "linear-signature": sign(b, "s") }, spec, { onWake: (r) => wakes.push(r) }, { MY_SECRET: "s" });
    expect(r.status).toBe(200);
    expect(wakes).toEqual([]);
  });

  it("skips invalidate when no callback is provided", () => {
    const b = body({ data: { team: { key: "ILO" } } });
    const r = dispatchWebhook(b, { "linear-signature": sign(b, "s") }, linear, { onWake: () => {} }, { MY_SECRET: "s" });
    expect(r.status).toBe(200);
  });

  it("bypasses secret check for auth.type=none", () => {
    const spec: WebhookSpec = {
      name: "n", path: "/webhook/n",
      auth: { type: "none" },
      onEvent: { wake: true },
    };
    const r = dispatchWebhook(body({}), {}, spec, { onWake: () => {} }, {});
    expect(r.status).toBe(200);
  });

  it("walks deep nested filter path", () => {
    const spec: WebhookSpec = { ...linear, filter: { jsonPath: "a.b.c.d", allow: ["z"] } };
    const b = body({ a: { b: { c: { d: "z" } } } });
    const r = dispatchWebhook(b, { "linear-signature": sign(b, "s") }, spec, { onWake: () => {} }, { MY_SECRET: "s" });
    expect(r.status).toBe(200);
  });
});

describe("handleWebhookRequest (http)", () => {
  let server: Server | null = null;
  afterEach(() => { server?.close(); server = null; });

  async function start(specs: WebhookSpec[], env: Record<string, string | undefined>, cbs: { onWake: (r: string) => void; invalidateSensor?: (n: string) => void }): Promise<number> {
    const s = createServer(async (req, res) => {
      await handleWebhookRequest(req, res, specs, cbs, env);
    });
    server = s;
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    return (s.address() as { port: number }).port;
  }

  it("returns 404 when no spec matches the path", async () => {
    const port = await start([linear], { MY_SECRET: "s" }, { onWake: () => {} });
    const res = await fetch(`http://127.0.0.1:${port}/webhook/unknown`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  it("dispatches through HTTP and fires wake + invalidate", async () => {
    const wakes: string[] = [];
    const inv: string[] = [];
    const port = await start([linear], { MY_SECRET: "s" }, {
      onWake: (r) => wakes.push(r),
      invalidateSensor: (n) => inv.push(n),
    });
    const b = body({ data: { team: { key: "ILO" } } });
    const res = await fetch(`http://127.0.0.1:${port}/webhook/linear`, {
      method: "POST",
      headers: { "linear-signature": sign(b, "s") },
      body: b,
    });
    expect(res.status).toBe(200);
    expect(wakes).toEqual(["webhook:linear"]);
    expect(inv).toEqual(["linear.new_issues"]);
  });

  it("strips query strings when matching the path", async () => {
    const port = await start([linear], { MY_SECRET: "s" }, { onWake: () => {} });
    const b = body({ data: { team: { key: "ILO" } } });
    const res = await fetch(`http://127.0.0.1:${port}/webhook/linear?trace=1`, {
      method: "POST",
      headers: { "linear-signature": sign(b, "s") },
      body: b,
    });
    expect(res.status).toBe(200);
  });
});
