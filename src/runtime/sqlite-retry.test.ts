import { describe, it, expect } from "vitest";
import { retrySync } from "./sqlite-retry.ts";

describe("retrySync", () => {
  it("returns immediately on success", () => {
    let n = 0;
    const r = retrySync(() => { n++; return "ok"; });
    expect(r).toBe("ok");
    expect(n).toBe(1);
  });

  it("retries on SQLITE_BUSY then succeeds", () => {
    let n = 0;
    const r = retrySync(() => {
      n++;
      if (n < 3) throw new Error("SQLITE_BUSY: database is locked");
      return "ok";
    });
    expect(r).toBe("ok");
    expect(n).toBe(3);
  });

  it("rethrows non-lock errors immediately", () => {
    expect(() => retrySync(() => { throw new Error("something else"); })).toThrow(/something else/);
  });

  it("gives up after N attempts", () => {
    expect(() => retrySync(() => { throw new Error("SQLITE_BUSY"); }, 2)).toThrow();
  });
});
