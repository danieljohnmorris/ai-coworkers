import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { runVerifier, verifyHmacSha256, verifyGithubSha256, verifySlackV0 } from "./webhook_verifiers.ts";

const body = (s: string) => Buffer.from(s, "utf8");

describe("verifyHmacSha256", () => {
  it("accepts a valid signature", () => {
    const b = body("hello");
    const sig = createHmac("sha256", "k").update(b).digest("hex");
    expect(verifyHmacSha256(b, { "x-sig": sig }, "k", { header: "x-sig" }).ok).toBe(true);
  });
  it("rejects wrong signature", () => {
    const r = verifyHmacSha256(body("hi"), { "x-sig": "a".repeat(64) }, "k", { header: "x-sig" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/bad signature/);
  });
  it("rejects length mismatch", () => {
    const r = verifyHmacSha256(body("hi"), { "x-sig": "abc" }, "k", { header: "x-sig" });
    expect(r.ok).toBe(false);
  });
  it("rejects missing header value", () => {
    const r = verifyHmacSha256(body("hi"), {}, "k", { header: "x-sig" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing signature/);
  });
  it("rejects missing header name in opts", () => {
    const r = verifyHmacSha256(body("hi"), {}, "k", {});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing header name/);
  });
  it("reads first array header value", () => {
    const b = body("x");
    const sig = createHmac("sha256", "k").update(b).digest("hex");
    expect(verifyHmacSha256(b, { "x-sig": [sig, "other"] }, "k", { header: "x-sig" }).ok).toBe(true);
  });
});

describe("verifyGithubSha256", () => {
  it("accepts sha256=<hex>", () => {
    const b = body("hi");
    const sig = "sha256=" + createHmac("sha256", "k").update(b).digest("hex");
    expect(verifyGithubSha256(b, { "x-hub-signature-256": sig }, "k", {}).ok).toBe(true);
  });
  it("accepts bare hex without prefix", () => {
    const b = body("hi");
    const sig = createHmac("sha256", "k").update(b).digest("hex");
    expect(verifyGithubSha256(b, { "x-hub-signature-256": sig }, "k", {}).ok).toBe(true);
  });
  it("uses custom header name from opts", () => {
    const b = body("hi");
    const sig = createHmac("sha256", "k").update(b).digest("hex");
    expect(verifyGithubSha256(b, { "x-alt": sig }, "k", { header: "x-alt" }).ok).toBe(true);
  });
  it("rejects missing header", () => {
    expect(verifyGithubSha256(body("hi"), {}, "k", {}).ok).toBe(false);
  });
  it("rejects bad sig", () => {
    const r = verifyGithubSha256(body("hi"), { "x-hub-signature-256": "sha256=" + "0".repeat(64) }, "k", {});
    expect(r.ok).toBe(false);
  });
});

describe("verifySlackV0", () => {
  const nowMs = 1_700_000_000_000;
  const ts = String(Math.floor(nowMs / 1000));
  const sign = (b: string) => "v0=" + createHmac("sha256", "k").update(`v0:${ts}:${b}`).digest("hex");
  it("accepts valid signature and fresh timestamp", () => {
    const b = "payload";
    const r = verifySlackV0(body(b), { "x-slack-signature": sign(b), "x-slack-request-timestamp": ts }, "k", {}, nowMs);
    expect(r.ok).toBe(true);
  });
  it("rejects missing signature header", () => {
    const r = verifySlackV0(body("x"), { "x-slack-request-timestamp": ts }, "k", {}, nowMs);
    expect(r.reason).toMatch(/x-slack-signature/);
  });
  it("rejects missing timestamp header", () => {
    const r = verifySlackV0(body("x"), { "x-slack-signature": "v0=abc" }, "k", {}, nowMs);
    expect(r.reason).toMatch(/timestamp/);
  });
  it("rejects non-numeric timestamp", () => {
    const r = verifySlackV0(body("x"), { "x-slack-signature": "v0=abc", "x-slack-request-timestamp": "nope" }, "k", {}, nowMs);
    expect(r.reason).toMatch(/bad timestamp/);
  });
  it("rejects stale timestamp beyond maxAgeSeconds", () => {
    const oldTs = String(Math.floor(nowMs / 1000) - 400);
    const r = verifySlackV0(body("x"), { "x-slack-signature": "v0=abc", "x-slack-request-timestamp": oldTs }, "k", {}, nowMs);
    expect(r.reason).toMatch(/stale/);
  });
  it("honours custom maxAgeSeconds", () => {
    const oldTs = String(Math.floor(nowMs / 1000) - 10);
    const r = verifySlackV0(body("x"), { "x-slack-signature": "v0=abc", "x-slack-request-timestamp": oldTs }, "k", { maxAgeSeconds: 5 }, nowMs);
    expect(r.reason).toMatch(/stale/);
  });
  it("rejects bad signature", () => {
    const r = verifySlackV0(body("x"), { "x-slack-signature": "v0=" + "0".repeat(64), "x-slack-request-timestamp": ts }, "k", {}, nowMs);
    expect(r.reason).toMatch(/bad signature/);
  });
});

describe("runVerifier dispatcher", () => {
  it("dispatches hmac-sha256", () => {
    const b = body("y");
    const sig = createHmac("sha256", "s").update(b).digest("hex");
    expect(runVerifier("hmac-sha256", { header: "x-sig" }, b, { "x-sig": sig }, "s").ok).toBe(true);
  });
  it("dispatches github-sha256", () => {
    const b = body("y");
    const sig = createHmac("sha256", "s").update(b).digest("hex");
    expect(runVerifier("github-sha256", {}, b, { "x-hub-signature-256": sig }, "s").ok).toBe(true);
  });
  it("dispatches slack-v0", () => {
    const nowMs = 1_700_000_000_000;
    const ts = String(Math.floor(nowMs / 1000));
    const b = "hi";
    const sig = "v0=" + createHmac("sha256", "s").update(`v0:${ts}:${b}`).digest("hex");
    expect(runVerifier("slack-v0", {}, body(b), { "x-slack-signature": sig, "x-slack-request-timestamp": ts }, "s", nowMs).ok).toBe(true);
  });
  it("dispatches none as always ok", () => {
    expect(runVerifier("none", {}, body(""), {}, "").ok).toBe(true);
  });
});
