import { describe, it, expect } from "vitest";
import { mask, unmask, maskDeep, newMaskTable } from "./pii_mask.ts";

describe("mask — pattern library", () => {
  it("masks 12-digit AWS account IDs", () => {
    const { masked, table } = mask("Account 123456789012 threw an error");
    expect(masked).toBe("Account <AWS_ACCOUNT_1> threw an error");
    expect(table.forward.get("<AWS_ACCOUNT_1>")).toBe("123456789012");
  });

  it("masks AWS ARNs whole", () => {
    const arn = "arn:aws:iam::123456789012:role/incident-responder";
    const { masked } = mask(`Assumed ${arn} at 12:00`);
    expect(masked).toContain("<AWS_ARN_1>");
    expect(masked).not.toContain("123456789012");
  });

  it("masks EC2 / EBS / VPC / subnet / SG ids", () => {
    const { masked } = mask("i-0abc1234def567890 in vpc-01234abcd and sg-abcdef01 and vol-0fedcba9876543210 and subnet-11223344");
    expect(masked).toMatch(/<EC2_INSTANCE_\d+>/);
    expect(masked).toMatch(/<VPC_\d+>/);
    expect(masked).toMatch(/<SG_\d+>/);
    expect(masked).toMatch(/<EBS_VOLUME_\d+>/);
    expect(masked).toMatch(/<SUBNET_\d+>/);
  });

  it("masks kubernetes pod names (deployment-hash-suffix)", () => {
    const { masked } = mask("checkout-api-77c5d8b9f7-xk4j2 restarted");
    expect(masked).toMatch(/<K8S_POD_\d+>/);
    expect(masked).not.toContain("checkout-api-77c5");
  });

  it("masks IPv4 addresses but preserves 127.0.0.1 and 0.0.0.0", () => {
    const { masked } = mask("Client 10.0.14.207 hitting 127.0.0.1 while bound to 0.0.0.0");
    expect(masked).toContain("<IPV4_1>");
    expect(masked).toContain("127.0.0.1");
    expect(masked).toContain("0.0.0.0");
  });

  it("preserves common AWS region strings", () => {
    const { masked } = mask("deployed to us-east-1 with vpc-01234abcd");
    expect(masked).toContain("us-east-1");
    expect(masked).toMatch(/<VPC_\d+>/);
  });

  it("masks UUIDs", () => {
    const { masked } = mask("Request 550e8400-e29b-41d4-a716-446655440000 failed");
    expect(masked).toContain("<UUID_1>");
    expect(masked).not.toContain("550e8400");
  });

  it("gives the SAME token to a repeated identifier within a session", () => {
    const t = newMaskTable();
    mask("pod checkout-api-77c5d8b9f7-xk4j2 first mention", t);
    const { masked } = mask("pod checkout-api-77c5d8b9f7-xk4j2 mentioned again", t);
    expect(masked).toContain("<K8S_POD_1>");
    // No K8S_POD_2 assigned — same identifier reused.
    expect(t.counters.get("K8S_POD")).toBe(1);
  });

  it("gives DIFFERENT tokens to different identifiers of the same kind", () => {
    const t = newMaskTable();
    mask("pod-a-77c5d8b9f7-xk4j2 and pod-b-88c5d8b9f7-yl5k3", t);
    expect(t.counters.get("K8S_POD")).toBe(2);
  });

  it("passes through text that contains no identifiers", () => {
    const { masked } = mask("simple error message with no PII");
    expect(masked).toBe("simple error message with no PII");
  });
});

describe("unmask", () => {
  it("restores masked identifiers", () => {
    const { masked, table } = mask("EC2 i-0abcdef1234567890 down");
    const restored = unmask(masked, table);
    expect(restored).toBe("EC2 i-0abcdef1234567890 down");
  });

  it("is idempotent on already-unmasked text", () => {
    const t = newMaskTable();
    const plain = "no tokens here";
    expect(unmask(plain, t)).toBe(plain);
  });

  it("handles overlapping token names (e.g. <UUID_1> before <UUID_11>)", () => {
    const t = newMaskTable();
    // Force many UUIDs so <UUID_10> and <UUID_1> exist.
    for (let i = 0; i < 12; i++) {
      mask(`req ${String(i).padStart(8, "0")}-e29b-41d4-a716-446655440000`, t);
    }
    // Build a string that references both <UUID_1> and <UUID_11>.
    const s = "see <UUID_1> and <UUID_11> in the log";
    const restored = unmask(s, t);
    // <UUID_11> must NOT become "<uuid1>1" or similar collision.
    expect(restored).toContain("00000010-e29b-41d4-a716-446655440000"); // UUID_11 (0-indexed → 10th one)
    expect(restored).toContain("00000000-e29b-41d4-a716-446655440000"); // UUID_1
  });
});

describe("maskDeep", () => {
  it("walks a nested object and masks every string", () => {
    const { masked, table } = maskDeep({
      cluster: "prod-eks",
      pods: ["checkout-api-77c5d8b9f7-xk4j2", "billing-api-88c5d8b9f7-yl5k3"],
      count: 42,                       // non-string preserved
      meta: { account: "123456789012", region: "us-east-1" },
    });
    expect((masked as any).pods[0]).toMatch(/<K8S_POD_/);
    expect((masked as any).meta.account).toMatch(/<AWS_ACCOUNT_/);
    expect((masked as any).count).toBe(42);
    expect((masked as any).meta.region).toBe("us-east-1"); // preserved
    // Table populated
    expect(table.forward.size).toBeGreaterThan(0);
  });

  it("preserves null / booleans / numbers", () => {
    const { masked } = maskDeep({ a: null, b: true, c: 3.14, d: "no pii here" });
    expect(masked).toEqual({ a: null, b: true, c: 3.14, d: "no pii here" });
  });
});
