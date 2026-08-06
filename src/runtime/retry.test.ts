import { describe, it, expect } from "vitest";
import { retryAsync, isTransient } from "./retry.ts";

describe("isTransient", () => {
  it("returns true for 5xx-shaped errors", () => {
    expect(isTransient(new Error("Linear 502: bad gateway"))).toBe(true);
    expect(isTransient(new Error("HTTP 503"))).toBe(true);
  });
  it("returns true for 429", () => {
    expect(isTransient(new Error("Slack 429: rate limited"))).toBe(true);
  });
  it("returns true for ECONNRESET and friends", () => {
    expect(isTransient(new Error("socket ECONNRESET"))).toBe(true);
    expect(isTransient(new Error("connection ETIMEDOUT"))).toBe(true);
  });
  it("returns true for abort/hang-up errors", () => {
    expect(isTransient(new Error("socket hang up"))).toBe(true);
    expect(isTransient(new Error("The operation was aborted"))).toBe(true);
  });
  it("handles non-Error thrown values (plain string)", () => {
    expect(isTransient("HTTP 503 down")).toBe(true);
    expect(isTransient("nope")).toBe(false);
  });
  it("returns false for deterministic errors", () => {
    expect(isTransient(new Error("Linear 401: unauthorized"))).toBe(false);
    expect(isTransient(new Error("Linear 404: not found"))).toBe(false);
    expect(isTransient(new Error("bad json"))).toBe(false);
  });
});

describe("retryAsync", () => {
  it("returns immediately on success", async () => {
    let n = 0;
    const r = await retryAsync(async () => { n++; return "ok"; });
    expect(r).toBe("ok");
    expect(n).toBe(1);
  });
  it("retries transient errors up to N attempts", async () => {
    let n = 0;
    const r = await retryAsync(async () => {
      n++;
      if (n < 3) throw new Error("Linear 502");
      return "ok";
    }, 3);
    expect(r).toBe("ok");
    expect(n).toBe(3);
  });
  it("rethrows deterministic errors immediately", async () => {
    let n = 0;
    await expect(retryAsync(async () => { n++; throw new Error("Linear 401"); })).rejects.toThrow();
    expect(n).toBe(1);
  });
  it("gives up after N attempts on persistent transient error", async () => {
    let n = 0;
    await expect(retryAsync(async () => { n++; throw new Error("HTTP 503"); }, 2)).rejects.toThrow();
    expect(n).toBe(2);
  });
});
