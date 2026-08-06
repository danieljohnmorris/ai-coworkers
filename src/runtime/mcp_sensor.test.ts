import { describe, it, expect } from "vitest";
import { McpSensorRunner, summarise, stableStringify, type McpClientLike } from "./mcp_sensor.ts";
import type { SensorSpec } from "./sensors_loader.ts";

const clientOf = (fn: (name: string, args?: unknown) => Promise<unknown>): McpClientLike => ({ callTool: fn });

describe("summarise", () => {
  it("identity returns raw", () => {
    expect(summarise({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(summarise({ a: 1 }, "identity")).toEqual({ a: 1 });
  });
  it("count finds first array", () => {
    expect(summarise({ issues: [1, 2, 3], meta: {} }, "count")).toEqual({ count: 3 });
    expect(summarise([1, 2], "count")).toEqual({ count: 2 });
    expect(summarise({ meta: 1 }, "count")).toEqual({ count: 0 });
  });
  it("first returns first element", () => {
    expect(summarise({ items: [{ id: 1 }, { id: 2 }] }, "first")).toEqual({ id: 1 });
    expect(summarise({ items: [] }, "first")).toBeNull();
    expect(summarise({ meta: 1 }, "first")).toBeNull();
  });
  it("dotted path extracts subtree", () => {
    expect(summarise({ data: { issues: [1, 2] } }, "data.issues")).toEqual([1, 2]);
    expect(summarise({ data: null }, "data.issues.x")).toBeUndefined();
  });
});

describe("stableStringify", () => {
  it("is key-order independent", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });
  it("preserves array order", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});

describe("McpSensorRunner", () => {
  const spec = (over: Partial<SensorSpec> = {}): SensorSpec => ({
    name: "s1", mcp: "srv", tool: "t", ...over,
  });

  it("calls the MCP tool and returns identity result", async () => {
    let calls = 0;
    const runner = new McpSensorRunner({
      specs: [spec()],
      mcpClients: new Map([["srv", clientOf(async () => { calls++; return { hello: "world" }; })]]),
    });
    const out = await runner.runOnce();
    expect(calls).toBe(1);
    expect(out).toEqual([{ name: "s1", result: { hello: "world" }, changedSinceLast: true }]);
  });

  it("reuses cache within TTL", async () => {
    let calls = 0;
    let clock = 1000;
    const runner = new McpSensorRunner({
      specs: [spec({ cacheMs: 5000 })],
      mcpClients: new Map([["srv", clientOf(async () => { calls++; return { n: calls }; })]]),
      now: () => clock,
    });
    await runner.runOnce();          // miss
    clock += 1000;
    await runner.runOnce();          // hit
    expect(calls).toBe(1);
    clock += 5000;                   // TTL expires
    const out = await runner.runOnce();
    expect(calls).toBe(2);
    expect(out[0].result).toEqual({ n: 2 });
  });

  it("calls every tick when cacheMs is 0/absent", async () => {
    let calls = 0;
    const runner = new McpSensorRunner({
      specs: [spec()],
      mcpClients: new Map([["srv", clientOf(async () => { calls++; return calls; })]]),
    });
    await runner.runOnce();
    await runner.runOnce();
    expect(calls).toBe(2);
  });

  it("captures MCP error on result without throwing", async () => {
    const runner = new McpSensorRunner({
      specs: [spec()],
      mcpClients: new Map([["srv", clientOf(async () => { throw new Error("boom"); })]]),
    });
    const out = await runner.runOnce();
    expect(out[0].error).toMatch(/boom/);
    expect(out[0].result).toBeNull();
  });

  it("emits a clear error when MCP client is missing", async () => {
    const runner = new McpSensorRunner({
      specs: [spec({ mcp: "nope" })],
      mcpClients: new Map(),
    });
    const out = await runner.runOnce();
    expect(out[0].error).toMatch(/no MCP client/);
  });

  it("applies summarise to the result", async () => {
    const runner = new McpSensorRunner({
      specs: [spec({ summarise: "count" })],
      mcpClients: new Map([["srv", clientOf(async () => ({ issues: [1, 2, 3, 4] }))]]),
    });
    const out = await runner.runOnce();
    expect(out[0].result).toEqual({ count: 4 });
  });

  it("changedSinceLast=false when value unchanged (key order ignored)", async () => {
    let n = 0;
    const runner = new McpSensorRunner({
      specs: [spec()],
      mcpClients: new Map([["srv", clientOf(async () => { n++; return n === 1 ? { a: 1, b: 2 } : { b: 2, a: 1 }; })]]),
    });
    const first = await runner.runOnce();
    expect(first[0].changedSinceLast).toBe(true);
    const second = await runner.runOnce();
    expect(second[0].changedSinceLast).toBe(false);
  });

  it("changedSinceLast=true when value changes", async () => {
    let n = 0;
    const runner = new McpSensorRunner({
      specs: [spec()],
      mcpClients: new Map([["srv", clientOf(async () => { n++; return { n }; })]]),
    });
    await runner.runOnce();
    const second = await runner.runOnce();
    expect(second[0].changedSinceLast).toBe(true);
  });

  it("invalidate drops the cache and forces changedSinceLast on next tick", async () => {
    let calls = 0;
    let clock = 1000;
    const runner = new McpSensorRunner({
      specs: [spec({ cacheMs: 60000 })],
      mcpClients: new Map([["srv", clientOf(async () => { calls++; return { same: 1 }; })]]),
      now: () => clock,
    });
    await runner.runOnce();          // call 1
    clock += 100;
    const cached = await runner.runOnce();
    expect(calls).toBe(1);            // cache hit
    expect(cached[0].changedSinceLast).toBe(false);

    runner.invalidate("s1");
    const forced = await runner.runOnce();
    expect(calls).toBe(2);            // cache dropped → fresh call
    // Even though value is identical, invalidate forces the diff.
    expect(forced[0].changedSinceLast).toBe(true);
  });

  it("passes args through to callTool", async () => {
    let received: unknown = null;
    const runner = new McpSensorRunner({
      specs: [spec({ args: { state: "open" } })],
      mcpClients: new Map([["srv", clientOf(async (_n, a) => { received = a; return {}; })]]),
    });
    await runner.runOnce();
    expect(received).toEqual({ state: "open" });
  });
});
