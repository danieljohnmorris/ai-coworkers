// OAuth 2.1 + PKCE client provider for MCP Streamable HTTP transport.
//
// Conforms to `OAuthClientProvider` shipped by @modelcontextprotocol/sdk
// (see node_modules/.../client/auth.d.ts). The SDK's `auth()` helper drives
// discovery (RFC 9728 + RFC 8414), dynamic client registration (RFC 7591),
// authorization-code exchange with PKCE (RFC 7636), and refresh — it just
// asks us to persist state and to open the browser.
//
// Storage layout: one JSON file per (coworker, server), under
//   <coworkerStateDir>/mcp-tokens/<serverName>.json
// containing client info, latest tokens, PKCE verifier for an in-flight
// authorization, and an authorization code delivered by the loopback
// listener.
//
// The loopback listener runs on 127.0.0.1:<port> (default: an ephemeral
// free port) and captures `?code=…` from the OAuth redirect. Because the
// SDK's `auth()` flow performs the authorization-code exchange inside a
// single logical call, we start the listener when `redirectToAuthorization`
// is invoked and stop it after the code arrives — the caller polls via
// `waitForCode()`.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import type {
  OAuthClientMetadata,
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface OAuthProviderOptions {
  serverName: string;                       // MCP server name, used for filename
  coworkerName: string;                     // coworker name, used in client_name
  coworkerStateDir: string;                 // coworkers/<name>/state
  scopes?: string[];                        // requested scopes; may be empty
  redirectPort?: number;                    // 0 = pick free port at listen time
  callbackHost?: string;                    // default 127.0.0.1
  // Injectable for tests:
  openBrowser?: (url: string) => Promise<void> | void;
  listenerFactory?: () => LoopbackListener;
}

interface StoredState {
  client_info?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  code_verifier?: string;
  // Absolute redirect URI advertised during DCR + used at token exchange.
  // Locked at first `redirectUrl` read so both requests match.
  redirect_uri?: string;
}

// --- PKCE helpers, RFC 7636 --------------------------------------------

// base64url per RFC 4648 § 5, no padding.
export function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// A 43-128 char high-entropy string. RFC 7636 recommends 32 random bytes → 43 chars.
export function generateCodeVerifier(bytes = 32): string {
  return base64UrlEncode(randomBytes(bytes));
}

// SHA-256(verifier), base64url, no padding.
export function computeCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

// --- Loopback listener --------------------------------------------------

export interface LoopbackListener {
  start(port: number, host: string): Promise<{ port: number; url: string }>;
  waitForCode(timeoutMs?: number): Promise<string>;
  stop(): Promise<void>;
}

export function createLoopbackListener(): LoopbackListener {
  let server: Server | null = null;
  let resolveCode: ((code: string) => void) | null = null;
  let rejectCode: ((err: Error) => void) | null = null;
  let settled = false;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = (c) => { if (!settled) { settled = true; res(c); } };
    rejectCode = (e) => { if (!settled) { settled = true; rej(e); } };
  });
  // Attach a no-op catch synchronously so the rejection is never observed
  // as "unhandled" if the caller races this against a timeout and the race
  // handler resolves the loser late.
  codePromise.catch(() => {});

  return {
    async start(port: number, host: string) {
      server = createServer((req, res) => {
        const u = new URL(req.url ?? "/", `http://${host}:${port}`);
        const code = u.searchParams.get("code");
        const err = u.searchParams.get("error");
        if (err) {
          res.statusCode = 400;
          res.end(`OAuth error: ${err}`);
          rejectCode?.(new Error(`Authorization server returned error: ${err}`));
          return;
        }
        if (code) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            "<html><body><h2>Authorization received.</h2><p>You can close this window.</p></body></html>",
          );
          resolveCode?.(code);
          return;
        }
        res.statusCode = 404;
        res.end("no code");
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(port, host, () => resolve());
      });
      const addr = server!.address() as AddressInfo;
      return { port: addr.port, url: `http://${host}:${addr.port}/callback` };
    },
    async waitForCode(timeoutMs = 5 * 60 * 1000) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<string>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error("Timed out waiting for OAuth callback")),
          timeoutMs,
        );
      });
      timeout.catch(() => {}); // avoid unhandled when codePromise wins
      try {
        return await Promise.race([codePromise, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async stop() {
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    },
  };
}

// --- Provider -----------------------------------------------------------

export class McpOAuthClientProvider {
  private readonly opts: OAuthProviderOptions;
  private readonly filePath: string;
  private state: StoredState;
  private listener: LoopbackListener | null = null;
  private listenerInfo: { port: number; url: string } | null = null;

  constructor(opts: OAuthProviderOptions) {
    this.opts = opts;
    this.filePath = join(
      opts.coworkerStateDir,
      "mcp-tokens",
      `${opts.serverName}.json`,
    );
    this.state = this.load();
  }

  private load(): StoredState {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as StoredState;
    } catch {
      return {};
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
  }

  // --- OAuthClientProvider interface ---

  get redirectUrl(): string {
    // Lock a redirect URI the first time we're asked. We prefer the port
    // configured explicitly; if omitted we listen on an ephemeral port
    // during redirectToAuthorization and rewrite the state before persist.
    if (this.state.redirect_uri) return this.state.redirect_uri;
    const host = this.opts.callbackHost ?? "127.0.0.1";
    const port = this.opts.redirectPort ?? 0;
    // If port==0 we don't yet know the real port; use a placeholder that
    // will be overwritten during redirectToAuthorization. Keep it a valid
    // URL so DCR schema validation passes at metadata build time.
    const effectivePort = port === 0 ? 33418 : port;
    return `http://${host}:${effectivePort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: `ai-coworkers/${this.opts.coworkerName}`,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: this.opts.scopes?.join(" "),
    };
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this.state.client_info;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.state.client_info = info;
    this.persist();
  }

  tokens(): OAuthTokens | undefined {
    return this.state.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.state.tokens = tokens;
    this.persist();
  }

  saveCodeVerifier(verifier: string): void {
    this.state.code_verifier = verifier;
    this.persist();
  }

  codeVerifier(): string {
    const v = this.state.code_verifier;
    if (!v) throw new Error("No PKCE code_verifier stored");
    return v;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Start the loopback listener now if we haven't already, and open the
    // browser (or print the URL). The SDK expects `redirectToAuthorization`
    // to be non-blocking — the caller feeds the code back separately via
    // `finishAuth(code)`. We keep the listener alive in this instance so
    // `waitForAuthorizationCode()` can retrieve it.
    if (!this.listener) {
      this.listener = (this.opts.listenerFactory ?? createLoopbackListener)();
      const host = this.opts.callbackHost ?? "127.0.0.1";
      const port = this.opts.redirectPort ?? 0;
      this.listenerInfo = await this.listener.start(port, host);
      this.state.redirect_uri = this.listenerInfo.url;
      this.persist();
    }
    const opener =
      this.opts.openBrowser ??
      ((url: string) => {
        console.log(`\n[mcp-oauth] Open this URL to authorize:\n${url}\n`);
      });
    await opener(authorizationUrl.toString());
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") this.state = {};
    else if (scope === "client") this.state.client_info = undefined;
    else if (scope === "tokens") this.state.tokens = undefined;
    else if (scope === "verifier") this.state.code_verifier = undefined;
    // 'discovery' state isn't persisted here yet — no-op.
    this.persist();
  }

  // --- Extras used by the caller (connectMcp) ---

  async waitForAuthorizationCode(timeoutMs?: number): Promise<string> {
    if (!this.listener) throw new Error("Listener not started; no in-flight OAuth flow");
    return this.listener.waitForCode(timeoutMs);
  }

  async shutdownListener(): Promise<void> {
    if (this.listener) {
      await this.listener.stop();
      this.listener = null;
      this.listenerInfo = null;
    }
  }

  // For tests / debugging
  get storagePath(): string {
    return this.filePath;
  }
}

export function createOAuthProvider(opts: OAuthProviderOptions): McpOAuthClientProvider {
  return new McpOAuthClientProvider(opts);
}
