import { describe, it, expect, vi } from "vitest";
import { buildDcrBody, registerClient } from "./mcp_dcr.ts";

describe("buildDcrBody", () => {
  it("produces the minimal RFC 7591 body", () => {
    const body = buildDcrBody({
      registrationEndpoint: "https://as.example/register",
      clientName: "ai-coworkers/triage",
      redirectUris: ["http://127.0.0.1:33418/callback"],
    });
    expect(body).toEqual({
      redirect_uris: ["http://127.0.0.1:33418/callback"],
      client_name: "ai-coworkers/triage",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("includes optional scope + software identity when provided", () => {
    const body = buildDcrBody({
      registrationEndpoint: "https://as.example/register",
      clientName: "x",
      redirectUris: ["http://127.0.0.1:1/callback"],
      scope: "read write",
      softwareId: "ai-coworkers",
      softwareVersion: "0.1.0",
    });
    expect(body.scope).toBe("read write");
    expect(body.software_id).toBe("ai-coworkers");
    expect(body.software_version).toBe("0.1.0");
  });
});

describe("registerClient", () => {
  const baseReq = {
    registrationEndpoint: "https://as.example/register",
    clientName: "ai-coworkers/x",
    redirectUris: ["http://127.0.0.1:33418/callback"],
  };

  it("returns client_id on 201 success", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          client_id: "abc123",
          client_secret: "secretxyz",
          client_id_issued_at: 1700000000,
          client_secret_expires_at: 0,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const res = await registerClient(baseReq, fetchImpl);
    expect(res.clientId).toBe("abc123");
    expect(res.clientSecret).toBe("secretxyz");
    expect(res.clientIdIssuedAt).toBe(1700000000);
    expect(res.clientSecretExpiresAt).toBe(0);
    expect(res.raw.client_id).toBe("abc123");
  });

  it("returns client_id without secret when server issues a public client", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ client_id: "pub" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const res = await registerClient(baseReq, fetchImpl);
    expect(res.clientId).toBe("pub");
    expect(res.clientSecret).toBeUndefined();
  });

  it("throws with status + body on 400", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_redirect_uri" }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(registerClient(baseReq, fetchImpl)).rejects.toThrow(/DCR failed \(400\)/);
  });

  it("throws on non-JSON success body", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("<html>not json</html>", { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(registerClient(baseReq, fetchImpl)).rejects.toThrow(/non-JSON body/);
  });

  it("throws when response is missing client_id", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ oops: true }), { status: 201 }),
    ) as unknown as typeof fetch;
    await expect(registerClient(baseReq, fetchImpl)).rejects.toThrow(/missing "client_id"/);
  });

  it("sends the RFC 7591 body as JSON to the registration endpoint", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(init!.body as string);
      expect(body.redirect_uris).toEqual(["http://127.0.0.1:33418/callback"]);
      expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
      return new Response(JSON.stringify({ client_id: "ok" }), { status: 201 });
    }) as unknown as typeof fetch;
    await registerClient(baseReq, fetchImpl);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });
});
