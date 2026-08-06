import { describe, it, expect } from "vitest";
import { redact, redactString, knownSecretsFrom } from "./secret_redaction.ts";

describe("redact — pattern library", () => {
  it("catches a Linear API key", () => {
    const r = redact("something went wrong for lin_api_ABCDEFGH12345678IJKL and retried");
    expect(r.text).toMatch(/<REDACTED:linear_api_key>/);
    expect(r.text).not.toContain("lin_api_ABC");
    expect(r.redactionCount).toBe(1);
  });

  it("catches a Slack bot token", () => {
    const r = redact("Slack error: token xoxb-1234-5678-9012-abcdef0123456789 rejected");
    expect(r.text).toContain("<REDACTED:slack_bot_token>");
  });

  it("catches a classic GitHub PAT", () => {
    const key = "ghp_" + "A".repeat(36);
    expect(redact(`X-GitHub: ${key}`).text).toContain("<REDACTED:github_pat_classic>");
  });

  it("catches a fine-grained GitHub PAT", () => {
    const key = "github_pat_" + "A".repeat(30);
    expect(redact(`token=${key}`).text).toContain("<REDACTED:github_pat_finegrained>");
  });

  it("catches Anthropic + OpenAI keys", () => {
    const ant = "sk-ant-" + "a".repeat(50);
    const oai = "sk-" + "B".repeat(48);
    const r = redact(`ant=${ant} oai=${oai}`);
    expect(r.text).toContain("<REDACTED:anthropic_key>");
    expect(r.text).toContain("<REDACTED:openai_key>");
    expect(r.redactionCount).toBe(2);
  });

  it("catches AWS + Google patterns", () => {
    const r = redact("AKIAIOSFODNN7EXAMPLE and AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI plus junk");
    expect(r.text).toContain("<REDACTED:aws_access_key>");
    expect(r.text).toContain("<REDACTED:google_api_key>");
  });

  it("catches PEM private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";
    const r = redact(`error dumping ${pem} into logs`);
    expect(r.text).toContain("<REDACTED:pem_private_key>");
    expect(r.text).not.toContain("MIIE");
  });

  it("catches Bearer / Basic tokens", () => {
    const r = redact("Authorization: Bearer abc123def456ghi789jkl_verylong");
    expect(r.text).toContain("<REDACTED:bearer_token>");
  });

  it("returns text unchanged when nothing matches", () => {
    const r = redact("Just a normal error message with no secrets.");
    expect(r.text).toBe("Just a normal error message with no secrets.");
    expect(r.redactionCount).toBe(0);
  });

  it("handles empty input", () => {
    expect(redact("")).toEqual({ text: "", redactionCount: 0 });
  });
});

describe("redact — known-value replacement", () => {
  it("replaces literal secret values with <REDACTED>", () => {
    const secret = "some-random-token-value-12345";
    const known = new Set([secret]);
    const r = redact(`Request failed: header ${secret} not accepted`, known);
    expect(r.text).toBe("Request failed: header <REDACTED> not accepted");
    expect(r.redactionCount).toBe(1);
  });

  it("escapes regex metacharacters in literal secrets", () => {
    const secret = "abc.def+ghi/jkl$mno"; // full of regex metachars
    const known = new Set([secret]);
    const r = redact(`Value: ${secret}`, known);
    expect(r.text).toBe("Value: <REDACTED>");
  });

  it("skips known values that don't appear in the text", () => {
    const known = new Set(["never-in-the-text"]);
    const r = redact("plain text", known);
    expect(r.text).toBe("plain text");
    expect(r.redactionCount).toBe(0);
  });
});

describe("knownSecretsFrom", () => {
  it("returns the values of every env var matching isCredentialName", () => {
    const set = knownSecretsFrom({
      HOME: "/home/dan",
      PATH: "/usr/bin",
      LINEAR_API_KEY: "lin_api_XXXX_a_secret_value",
      SLACK_BOT_TOKEN: "xoxb-something-long-enough",
      OPENAI_API_KEY: "sk-shortbutok-and-more-chars",
    } as NodeJS.ProcessEnv);
    expect(set.has("lin_api_XXXX_a_secret_value")).toBe(true);
    expect(set.has("xoxb-something-long-enough")).toBe(true);
    expect(set.has("sk-shortbutok-and-more-chars")).toBe(true);
    expect(set.has("/home/dan")).toBe(false); // not a credential name
  });

  it("skips empty and very-short values (false-positive protection)", () => {
    const set = knownSecretsFrom({
      LINEAR_API_KEY: "",
      SLACK_BOT_TOKEN: "abc",  // < 8 chars
    } as NodeJS.ProcessEnv);
    expect(set.size).toBe(0);
  });
});

describe("redactString", () => {
  it("returns just the redacted text", () => {
    expect(redactString("lin_api_ABCDEFGH12345678IJKL")).toContain("<REDACTED:linear_api_key>");
  });
});
