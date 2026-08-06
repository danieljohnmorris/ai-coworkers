import { describe, it, expect } from "vitest";
import { parseWakeMode } from "./wake_mode.ts";

describe("parseWakeMode", () => {
  it("defaults to both when unset", () => {
    expect(parseWakeMode(undefined)).toEqual({ mode: "both" });
  });

  it("defaults to both when empty string", () => {
    expect(parseWakeMode("")).toEqual({ mode: "both" });
  });

  it("accepts tick", () => {
    expect(parseWakeMode("tick")).toEqual({ mode: "tick" });
  });

  it("accepts webhook", () => {
    expect(parseWakeMode("webhook")).toEqual({ mode: "webhook" });
  });

  it("accepts both", () => {
    expect(parseWakeMode("both")).toEqual({ mode: "both" });
  });

  it("is case-insensitive", () => {
    expect(parseWakeMode("Webhook")).toEqual({ mode: "webhook" });
    expect(parseWakeMode("TICK")).toEqual({ mode: "tick" });
  });

  it("warns and falls back to both on unknown value", () => {
    const r = parseWakeMode("sometimes");
    expect(r.mode).toBe("both");
    expect(r.warning).toContain("sometimes");
    expect(r.warning).toContain("both");
  });
});
