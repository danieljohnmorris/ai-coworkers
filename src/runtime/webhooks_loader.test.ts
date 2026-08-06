import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWebhooks } from "./webhooks_loader.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "webhooks-loader-"));
}

function write(dir: string, content: string): void {
  writeFileSync(join(dir, "WEBHOOKS.json"), content);
}

describe("loadWebhooks", () => {
  it("returns empty when file missing", () => {
    const dir = scratch();
    try {
      const r = loadWebhooks(dir);
      expect(r.specs).toEqual([]);
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports one error on invalid JSON", () => {
    const dir = scratch();
    try {
      write(dir, "{not json");
      const r = loadWebhooks(dir);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/bad JSON/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects non-array top-level", () => {
    const dir = scratch();
    try {
      write(dir, `{"name":"x"}`);
      const r = loadWebhooks(dir);
      expect(r.errors[0]).toMatch(/must be an array/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("loads a valid spec and warns on auth.type=none", () => {
    const dir = scratch();
    try {
      write(dir, JSON.stringify([
        { name: "n1", path: "/webhook/n1", auth: { type: "none" }, onEvent: { wake: true } },
      ]));
      const r = loadWebhooks(dir);
      expect(r.specs).toHaveLength(1);
      expect(r.warnings[0]).toMatch(/auth\.type "none"/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("accumulates per-spec validation errors", () => {
    const dir = scratch();
    try {
      write(dir, JSON.stringify([
        null,
        { path: "/webhook/x", auth: { type: "none" }, onEvent: { wake: true } },                 // missing name
        { name: "n", path: "/nope", auth: { type: "none" }, onEvent: { wake: true } },           // bad path
        { name: "n2", path: "/webhook/x", auth: {} , onEvent: { wake: true } },                  // bad auth.type
        { name: "n3", path: "/webhook/x", auth: { type: "hmac-sha256", secretEnv: "S" }, onEvent: { wake: true } },  // hmac missing header
        { name: "n4", path: "/webhook/x", auth: { type: "hmac-sha256", header: "h" }, onEvent: { wake: true } },     // missing secretEnv
        { name: "n5", path: "/webhook/x", auth: { type: "none", maxAgeSeconds: -1 }, onEvent: { wake: true } },      // bad maxAge
        { name: "n6", path: "/webhook/x", auth: { type: "none" }, filter: "nope", onEvent: { wake: true } },         // bad filter
        { name: "n7", path: "/webhook/x", auth: { type: "none" }, filter: { jsonPath: "a", allow: [1] }, onEvent: { wake: true } }, // bad allow
        { name: "n8", path: "/webhook/x", auth: { type: "none" }, filter: { allow: ["x"] }, onEvent: { wake: true } }, // missing jsonPath
        { name: "n9", path: "/webhook/x", auth: { type: "none" } },                              // missing onEvent
        { name: "n10", path: "/webhook/x", auth: { type: "none" }, onEvent: { wake: true, invalidate: [1] } }, // bad invalidate
      ]));
      const r = loadWebhooks(dir);
      expect(r.errors.length).toBeGreaterThanOrEqual(11);
      expect(r.specs).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("detects duplicate names", () => {
    const dir = scratch();
    try {
      write(dir, JSON.stringify([
        { name: "same", path: "/webhook/a", auth: { type: "none" }, onEvent: { wake: true } },
        { name: "same", path: "/webhook/b", auth: { type: "none" }, onEvent: { wake: true } },
      ]));
      const r = loadWebhooks(dir);
      expect(r.specs).toHaveLength(1);
      expect(r.errors[0]).toMatch(/duplicate/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("loads full spec with filter and invalidate", () => {
    const dir = scratch();
    try {
      write(dir, JSON.stringify([{
        name: "linear",
        path: "/webhook/linear",
        auth: { type: "hmac-sha256", header: "linear-signature", secretEnv: "S", maxAgeSeconds: 60 },
        filter: { jsonPath: "data.team.key", allow: ["ILO"] },
        onEvent: { wake: true, invalidate: ["linear.new_issues"] },
      }]));
      const r = loadWebhooks(dir);
      expect(r.errors).toEqual([]);
      expect(r.specs[0].filter?.allow).toEqual(["ILO"]);
      expect(r.specs[0].onEvent.invalidate).toEqual(["linear.new_issues"]);
      expect(r.specs[0].auth.maxAgeSeconds).toBe(60);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("defaults wake=true when omitted", () => {
    const dir = scratch();
    try {
      write(dir, JSON.stringify([
        { name: "n", path: "/webhook/n", auth: { type: "none" }, onEvent: {} },
      ]));
      const r = loadWebhooks(dir);
      expect(r.specs[0].onEvent.wake).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
