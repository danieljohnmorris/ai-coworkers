import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCoworkerConfig, _resetWarnedKeysForTests } from "./coworker_config.ts";

function tmpCoworker(): string {
  return mkdtempSync(join(tmpdir(), "cwcfg-"));
}

describe("loadCoworkerConfig", () => {
  beforeEach(() => { _resetWarnedKeysForTests(); });

  it("returns schema defaults when no config.json and no env vars", () => {
    const dir = tmpCoworker();
    try {
      const cfg = loadCoworkerConfig(dir, {});
      expect(cfg).toEqual({
        wake_mode: "both",
        extract_entities: false,
        max_tools_per_tick: 8,
        pii_mask: false,
        note_require_signed: false,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads config.json values and validates against the schema", () => {
    const dir = tmpCoworker();
    try {
      writeFileSync(join(dir, "config.json"), JSON.stringify({
        wake_mode: "webhook",
        extract_entities: true,
        max_tools_per_tick: 3,
        pii_mask: true,
        note_require_signed: true,
      }));
      const cfg = loadCoworkerConfig(dir, {});
      expect(cfg.wake_mode).toBe("webhook");
      expect(cfg.extract_entities).toBe(true);
      expect(cfg.max_tools_per_tick).toBe(3);
      expect(cfg.pii_mask).toBe(true);
      expect(cfg.note_require_signed).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("falls back to env vars when config.json missing, and warns once", () => {
    const dir = tmpCoworker();
    const warnings: string[] = [];
    try {
      const cfg = loadCoworkerConfig(dir, {
        WAKE_MODE: "tick",
        EXTRACT_ENTITIES: "1",
        MAX_TOOLS_PER_TICK: "12",
        PII_MASK: "1",
        NOTE_REQUIRE_SIGNED: "1",
      }, { warn: (m) => warnings.push(m) });
      expect(cfg).toEqual({
        wake_mode: "tick",
        extract_entities: true,
        max_tools_per_tick: 12,
        pii_mask: true,
        note_require_signed: true,
      });
      expect(warnings.filter((w) => w.includes("env fallback"))).toHaveLength(5);
      // second call should not re-warn for the same key
      _resetWarnedKeysForTests();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("config.json wins over env and warns about the clash", () => {
    const dir = tmpCoworker();
    const warnings: string[] = [];
    try {
      writeFileSync(join(dir, "config.json"), JSON.stringify({ wake_mode: "webhook" }));
      const cfg = loadCoworkerConfig(dir, { WAKE_MODE: "tick" }, { warn: (m) => warnings.push(m) });
      expect(cfg.wake_mode).toBe("webhook");
      expect(warnings.some((w) => w.includes("WAKE_MODE") && w.includes("overridden"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("throws a clear error when config.json fails schema validation", () => {
    const dir = tmpCoworker();
    try {
      writeFileSync(join(dir, "config.json"), JSON.stringify({ wake_mode: "sometimes" }));
      expect(() => loadCoworkerConfig(dir, {})).toThrow(/wake_mode/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("throws a clear error when config.json is not valid JSON", () => {
    const dir = tmpCoworker();
    try {
      writeFileSync(join(dir, "config.json"), "{ not: json");
      expect(() => loadCoworkerConfig(dir, {})).toThrow(/parse error/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("mixes config.json overrides with env fallback for un-set keys", () => {
    const dir = tmpCoworker();
    const warnings: string[] = [];
    try {
      writeFileSync(join(dir, "config.json"), JSON.stringify({ wake_mode: "tick" }));
      const cfg = loadCoworkerConfig(dir, { PII_MASK: "1" }, { warn: (m) => warnings.push(m) });
      expect(cfg.wake_mode).toBe("tick");
      expect(cfg.pii_mask).toBe(true);
      // env fallback for PII_MASK should have warned; no clash on WAKE_MODE (env not set)
      expect(warnings.some((w) => w.includes("PII_MASK") && w.includes("env fallback"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects out-of-range max_tools_per_tick", () => {
    const dir = tmpCoworker();
    try {
      writeFileSync(join(dir, "config.json"), JSON.stringify({ max_tools_per_tick: 0 }));
      expect(() => loadCoworkerConfig(dir, {})).toThrow(/max_tools_per_tick/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
