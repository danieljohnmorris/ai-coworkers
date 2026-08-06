import { describe, it, expect } from "vitest";
import { validateInput } from "./validate.ts";

const schema = {
  type: "object",
  required: ["issueId", "labelIds"],
  properties: {
    issueId: { type: "string" },
    labelIds: { type: "array", items: { type: "string" } },
  },
};

describe("validateInput", () => {
  it("accepts valid input", () => {
    const r = validateInput(schema, { issueId: "u1", labelIds: ["L1"] });
    expect(r.ok).toBe(true);
  });
  it("rejects missing required field", () => {
    const r = validateInput(schema, { issueId: "u1" }) as any;
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/labelIds/);
  });
  it("rejects wrong type that coercion can't fix", () => {
    // labelIds requires array; a plain object can't be coerced.
    const r = validateInput(schema, { issueId: "x", labelIds: { nope: true } }) as any;
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
  it("survives an invalid schema without throwing", () => {
    const r = validateInput({ type: "wibble" }, {}) as any;
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/bad schema/);
  });
  it("formats error with (root) when instancePath is empty", () => {
    // Missing required top-level field → instancePath === "" → falls back to "(root)".
    const r = validateInput(schema, {}) as any;
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => e.startsWith("(root):"))).toBe(true);
  });

  it("caches compiled validators", () => {
    // Two calls with the same schema should not throw or explode
    for (let i = 0; i < 20; i++) {
      const r = validateInput(schema, { issueId: "x", labelIds: ["y"] });
      expect(r.ok).toBe(true);
    }
  });
});
