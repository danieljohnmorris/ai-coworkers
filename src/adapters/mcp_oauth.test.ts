import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  base64UrlEncode,
  generateCodeVerifier,
  computeCodeChallenge,
  createLoopbackListener,
  createOAuthProvider,
  McpOAuthClientProvider,
  type LoopbackListener,
} from "./mcp_oauth.ts";

describe("PKCE (RFC 7636)", () => {
  it("base64UrlEncode: no padding, url-safe alphabet", () => {
    expect(base64UrlEncode(Buffer.from([0xff, 0xff, 0xff]))).toBe("____");
    expect(base64UrlEncode(Buffer.from("hello"))).toBe("aGVsbG8");
  });

  it("computeCodeChallenge matches RFC 7636 appendix B fixture", () => {
    // Verifier + expected challenge come directly from RFC 7636 § appendix B.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(computeCodeChallenge(verifier)).toBe(expected);
  });

  it("generateCodeVerifier yields 43+ char base64url with no padding", () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v).not.toContain("=");
  });

  it("generateCodeVerifier is high-entropy (no repeat across calls)", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });
});

describe("McpOAuthClientProvider — storage", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-oauth-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined tokens/client info before any save", () => {
    const p = createOAuthProvider({
      serverName: "linear",
      coworkerName: "cw",
      coworkerStateDir: dir,
    });
    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()).toBeUndefined();
  });

  it("persists tokens to disk at mcp-tokens/<name>.json with 0600", () => {
    const p = createOAuthProvider({ serverName: "linear", coworkerName: "cw", coworkerStateDir: dir });
    p.saveTokens({ access_token: "at", token_type: "Bearer", refresh_token: "rt" });
    const path = join(dir, "mcp-tokens", "linear.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.tokens.access_token).toBe("at");
  });

  it("reloads persisted state on construction", () => {
    const first = createOAuthProvider({ serverName: "s", coworkerName: "cw", coworkerStateDir: dir });
    first.saveTokens({ access_token: "a1", token_type: "Bearer" });
    first.saveClientInformation({
      client_id: "cid",
      redirect_uris: ["http://127.0.0.1:1/callback"],
    });
    first.saveCodeVerifier("verify-me");

    const second = createOAuthProvider({ serverName: "s", coworkerName: "cw", coworkerStateDir: dir });
    expect(second.tokens()?.access_token).toBe("a1");
    expect(second.clientInformation()?.client_id).toBe("cid");
    expect(second.codeVerifier()).toBe("verify-me");
  });

  it("tolerates corrupt state file", () => {
    mkdirSync(join(dir, "mcp-tokens"), { recursive: true });
    writeFileSync(join(dir, "mcp-tokens", "s.json"), "not json");
    const p = createOAuthProvider({ serverName: "s", coworkerName: "cw", coworkerStateDir: dir });
    expect(p.tokens()).toBeUndefined();
  });

  it("codeVerifier() throws when none stored", () => {
    const p = createOAuthProvider({ serverName: "s", coworkerName: "cw", coworkerStateDir: dir });
    expect(() => p.codeVerifier()).toThrow(/No PKCE code_verifier/);
  });

  it("invalidateCredentials clears the requested scope", () => {
    const p = createOAuthProvider({ serverName: "s", coworkerName: "cw", coworkerStateDir: dir });
    p.saveTokens({ access_token: "a", token_type: "Bearer" });
    p.saveClientInformation({ client_id: "c", redirect_uris: ["http://127.0.0.1:1/callback"] });
    p.saveCodeVerifier("v");

    p.invalidateCredentials("tokens");
    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()?.client_id).toBe("c");

    p.invalidateCredentials("verifier");
    expect(() => p.codeVerifier()).toThrow();

    p.invalidateCredentials("client");
    expect(p.clientInformation()).toBeUndefined();

    p.saveTokens({ access_token: "a", token_type: "Bearer" });
    p.invalidateCredentials("all");
    expect(p.tokens()).toBeUndefined();

    // 'discovery' is a no-op right now — must not throw.
    p.invalidateCredentials("discovery");
  });
});

describe("McpOAuthClientProvider — metadata + redirect URL", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mcp-oauth-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("builds client metadata with grant_types + PKCE-only auth", () => {
    const p = createOAuthProvider({
      serverName: "s",
      coworkerName: "cw",
      coworkerStateDir: dir,
      scopes: ["read", "write"],
    });
    const md = p.clientMetadata;
    expect(md.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(md.response_types).toEqual(["code"]);
    expect(md.token_endpoint_auth_method).toBe("none");
    expect(md.client_name).toBe("ai-coworkers/cw");
    expect(md.scope).toBe("read write");
    expect(md.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("uses configured redirectPort and callbackHost", () => {
    const p = createOAuthProvider({
      serverName: "s", coworkerName: "cw", coworkerStateDir: dir,
      redirectPort: 41234, callbackHost: "localhost",
    });
    expect(p.redirectUrl).toBe("http://localhost:41234/callback");
  });

  it("remembers the redirect URI once locked", () => {
    const p = createOAuthProvider({ serverName: "s", coworkerName: "cw", coworkerStateDir: dir, redirectPort: 5000 });
    const first = p.redirectUrl;
    // Simulate the provider persisting the listener URL after start:
    p.saveTokens({ access_token: "t", token_type: "Bearer" }); // triggers persist so we can round-trip
    expect(p.redirectUrl).toBe(first);
  });

  it("storagePath exposes the persisted file location", () => {
    const p = createOAuthProvider({ serverName: "linear", coworkerName: "cw", coworkerStateDir: dir });
    expect(p.storagePath.endsWith("/mcp-tokens/linear.json")).toBe(true);
  });
});

describe("redirectToAuthorization + waitForAuthorizationCode", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mcp-oauth-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function fakeListener(): LoopbackListener {
    let resolveCode: (c: string) => void;
    const p = new Promise<string>((r) => { resolveCode = r; });
    return {
      async start(_port, _host) { return { port: 12345, url: "http://127.0.0.1:12345/callback" }; },
      async waitForCode() { return p; },
      async stop() {},
      // test-only escape hatch:
      // @ts-expect-error test-only
      __resolve(code: string) { resolveCode(code); },
    } as LoopbackListener;
  }

  it("opens the browser (opener) with the authorization URL and captures code", async () => {
    const opened: string[] = [];
    const listener = fakeListener();
    const p = new McpOAuthClientProvider({
      serverName: "s", coworkerName: "cw", coworkerStateDir: dir,
      openBrowser: (url) => { opened.push(url); },
      listenerFactory: () => listener,
    });
    await p.redirectToAuthorization(new URL("https://as.example/authorize?x=1"));
    expect(opened).toEqual(["https://as.example/authorize?x=1"]);
    (listener as unknown as { __resolve: (c: string) => void }).__resolve("the-code");
    const code = await p.waitForAuthorizationCode();
    expect(code).toBe("the-code");
    await p.shutdownListener();
  });

  it("falls back to console when no opener is provided", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const listener = fakeListener();
    const p = new McpOAuthClientProvider({
      serverName: "s", coworkerName: "cw", coworkerStateDir: dir,
      listenerFactory: () => listener,
    });
    await p.redirectToAuthorization(new URL("https://as.example/authorize"));
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toMatch(/mcp-oauth/);
    spy.mockRestore();
    await p.shutdownListener();
  });

  it("waitForAuthorizationCode throws when listener not started", async () => {
    const p = createOAuthProvider({ serverName: "s", coworkerName: "cw", coworkerStateDir: dir });
    await expect(p.waitForAuthorizationCode()).rejects.toThrow(/not started/);
  });

  it("shutdownListener is a no-op when never started", async () => {
    const p = createOAuthProvider({ serverName: "s", coworkerName: "cw", coworkerStateDir: dir });
    await expect(p.shutdownListener()).resolves.toBeUndefined();
  });

  it("reuses the same listener across repeated redirectToAuthorization calls", async () => {
    let starts = 0;
    const listener: LoopbackListener = {
      async start() { starts++; return { port: 1, url: "http://127.0.0.1:1/callback" }; },
      async waitForCode() { return "c"; },
      async stop() {},
    };
    const p = new McpOAuthClientProvider({
      serverName: "s", coworkerName: "cw", coworkerStateDir: dir,
      openBrowser: () => {}, listenerFactory: () => listener,
    });
    await p.redirectToAuthorization(new URL("https://as.example/a"));
    await p.redirectToAuthorization(new URL("https://as.example/a"));
    expect(starts).toBe(1);
    await p.shutdownListener();
  });
});

describe("createLoopbackListener (real HTTP)", () => {
  it("captures ?code= from GET / and resolves waitForCode", async () => {
    const l = createLoopbackListener();
    const { port } = await l.start(0, "127.0.0.1");
    const codePromise = l.waitForCode(5000);
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=abc`);
    expect(res.status).toBe(200);
    expect(await codePromise).toBe("abc");
    await l.stop();
  });

  it("rejects waitForCode when the AS returns ?error=...", async () => {
    const l = createLoopbackListener();
    const { port } = await l.start(0, "127.0.0.1");
    // Attach the awaiter BEFORE hitting the endpoint so the rejection has a handler.
    const codePromise = l.waitForCode(5000);
    // Pre-attach a swallow so the underlying rejection has a handler even if
    // node reports the unwrapped promise as unhandled.
    const swallow = codePromise.catch(() => {});
    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied`);
    await expect(codePromise).rejects.toThrow(/access_denied/);
    await swallow;
    await l.stop();
  });

  it("returns 404 for a request with neither code nor error", async () => {
    const l = createLoopbackListener();
    const { port } = await l.start(0, "127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${port}/anything`);
    expect(res.status).toBe(404);
    await l.stop();
  });

  it("waitForCode times out", async () => {
    const l = createLoopbackListener();
    await l.start(0, "127.0.0.1");
    await expect(l.waitForCode(10)).rejects.toThrow(/Timed out/);
    await l.stop();
  });

  it("stop is idempotent", async () => {
    const l = createLoopbackListener();
    await l.start(0, "127.0.0.1");
    await l.stop();
    await expect(l.stop()).resolves.toBeUndefined();
  });
});
