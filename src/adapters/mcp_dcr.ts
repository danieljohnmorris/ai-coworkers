// RFC 7591 Dynamic Client Registration helper for MCP OAuth flows.
//
// A remote MCP server that requires OAuth 2.1 (e.g. Linear's mcp.linear.app)
// advertises a registration endpoint via authorization-server metadata. We
// POST minimal client metadata and receive back a `client_id` (and, for
// confidential clients, a `client_secret`) which we then persist so the
// authorization-code flow can proceed.
//
// This module is transport-agnostic — no browser, no PKCE. It's a pure
// HTTP round-trip described by RFC 7591 § 3.

export interface DcrRequest {
  registrationEndpoint: string;             // absolute URL from AS metadata
  clientName: string;                       // human-readable label, e.g. "ai-coworkers/triage"
  redirectUris: string[];                   // must include the loopback URI we listen on
  scope?: string;                           // space-separated; may be omitted
  softwareId?: string;                      // stable identifier for this software product
  softwareVersion?: string;
}

export interface DcrResult {
  clientId: string;
  clientSecret?: string;                    // present only for confidential clients
  clientIdIssuedAt?: number;                // epoch seconds
  clientSecretExpiresAt?: number;           // 0 = never, per RFC 7591
  raw: Record<string, unknown>;             // full server response for debugging
}

// Build the RFC 7591 request body. Pure function — no I/O — so tests can
// pin the exact serialisation.
export function buildDcrBody(req: DcrRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    redirect_uris: req.redirectUris,
    client_name: req.clientName,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",     // PKCE-only public client
  };
  if (req.scope) body.scope = req.scope;
  if (req.softwareId) body.software_id = req.softwareId;
  if (req.softwareVersion) body.software_version = req.softwareVersion;
  return body;
}

export async function registerClient(
  req: DcrRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<DcrResult> {
  const body = buildDcrBody(req);
  const res = await fetchImpl(req.registrationEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `DCR failed (${res.status}) at ${req.registrationEndpoint}: ${text}`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `DCR: registration endpoint returned non-JSON body: ${text.slice(0, 200)}`,
    );
  }
  const clientId = parsed.client_id;
  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new Error(`DCR: response missing "client_id": ${text.slice(0, 200)}`);
  }
  return {
    clientId,
    clientSecret: typeof parsed.client_secret === "string" ? parsed.client_secret : undefined,
    clientIdIssuedAt:
      typeof parsed.client_id_issued_at === "number" ? parsed.client_id_issued_at : undefined,
    clientSecretExpiresAt:
      typeof parsed.client_secret_expires_at === "number"
        ? parsed.client_secret_expires_at
        : undefined,
    raw: parsed,
  };
}
