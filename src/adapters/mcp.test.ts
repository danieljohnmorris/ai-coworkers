import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseMcpEnv, validateMcpConfig, buildHttpHeaders, type McpServerConfig } from "./mcp.ts";

// Capture constructor args so we can assert transport wiring in connectMcp tests.
const stdioCtor = vi.fn();
const httpCtor = vi.fn();
const clientConnect = vi.fn(async () => {});
const clientClose = vi.fn(async () => {});
const clientListTools = vi.fn(async () => ({
  tools: [{ name: "ping", description: "test", inputSchema: { type: "object" } }],
}));
const clientCallTool = vi.fn(async () => ({ ok: true }));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    constructor(..._args: unknown[]) {}
    connect = clientConnect;
    close = clientClose;
    listTools = clientListTools;
    callTool = clientCallTool;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(opts: unknown) { stdioCtor(opts); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, opts: unknown) { httpCtor(url, opts); }
  },
}));

beforeEach(() => {
  stdioCtor.mockClear();
  httpCtor.mockClear();
  clientConnect.mockClear();
  clientClose.mockClear();
  clientListTools.mockClear();
  clientCallTool.mockClear();
});

describe("parseMcpEnv", () => {
  it("returns [] when unset", () => {
    expect(parseMcpEnv({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("returns [] on malformed json", () => {
    expect(parseMcpEnv({ MCP_SERVERS: "not json" } as unknown as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("returns [] when top-level is not an array", () => {
    expect(parseMcpEnv({ MCP_SERVERS: '{"name":"x","command":"y"}' } as unknown as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("parses well-formed stdio configs", () => {
    const raw = JSON.stringify([
      { name: "github", command: "npx", args: ["@modelcontextprotocol/server-github"] },
      { name: "fs", command: "mcp-server-fs" },
    ]);
    const got = parseMcpEnv({ MCP_SERVERS: raw } as unknown as NodeJS.ProcessEnv);
    expect(got.length).toBe(2);
    expect(got[0].name).toBe("github");
    expect(got[1].args).toBeUndefined();
  });

  it("parses http configs with url", () => {
    const raw = JSON.stringify([
      { name: "remote", url: "https://mcp.example.com/mcp", bearerEnv: "EXAMPLE_TOKEN" },
    ]);
    const got = parseMcpEnv({ MCP_SERVERS: raw } as unknown as NodeJS.ProcessEnv);
    expect(got.length).toBe(1);
    expect(got[0].url).toBe("https://mcp.example.com/mcp");
    expect(got[0].bearerEnv).toBe("EXAMPLE_TOKEN");
  });

  it("filters entries missing name or both transports", () => {
    const raw = JSON.stringify([
      { name: "x" },
      { command: "y" },
      { name: "ok", command: "cmd" },
      { name: "ok2", url: "https://example.com" },
    ]);
    const got = parseMcpEnv({ MCP_SERVERS: raw } as unknown as NodeJS.ProcessEnv);
    expect(got.length).toBe(2);
    expect(got.map((s) => s.name)).toEqual(["ok", "ok2"]);
  });
});

describe("validateMcpConfig", () => {
  it("returns 'stdio' when only command is set", () => {
    expect(validateMcpConfig({ name: "x", command: "y" })).toBe("stdio");
  });

  it("returns 'http' when only url is set", () => {
    expect(validateMcpConfig({ name: "x", url: "https://e.com/mcp" })).toBe("http");
  });

  it("throws when both command and url set", () => {
    expect(() =>
      validateMcpConfig({ name: "both", command: "y", url: "https://e.com/mcp" }),
    ).toThrow(/both "command" and "url"/);
  });

  it("throws when neither command nor url set", () => {
    expect(() => validateMcpConfig({ name: "empty" } as McpServerConfig)).toThrow(
      /neither "command" nor "url"/,
    );
  });

  it("treats empty-string command/url as absent", () => {
    expect(() => validateMcpConfig({ name: "e", command: "", url: "" })).toThrow(
      /neither "command" nor "url"/,
    );
  });
});

describe("buildHttpHeaders", () => {
  it("returns empty object when no headers or bearerEnv", () => {
    expect(buildHttpHeaders({ name: "x", url: "https://e" }, {})).toEqual({});
  });

  it("passes static headers through unchanged", () => {
    const headers = { "X-Foo": "bar", "X-Baz": "qux" };
    const got = buildHttpHeaders({ name: "x", url: "https://e", headers }, {});
    expect(got).toEqual(headers);
    // Should not be the same reference (avoid caller mutation).
    expect(got).not.toBe(headers);
  });

  it("reads bearerEnv and sets Authorization: Bearer <value>", () => {
    const got = buildHttpHeaders(
      { name: "x", url: "https://e", bearerEnv: "MY_TOKEN" },
      { MY_TOKEN: "secret-abc" } as NodeJS.ProcessEnv,
    );
    expect(got).toEqual({ Authorization: "Bearer secret-abc" });
  });

  it("combines static headers with bearerEnv", () => {
    const got = buildHttpHeaders(
      { name: "x", url: "https://e", headers: { "X-Foo": "bar" }, bearerEnv: "MY_TOKEN" },
      { MY_TOKEN: "tok" } as NodeJS.ProcessEnv,
    );
    expect(got).toEqual({ "X-Foo": "bar", Authorization: "Bearer tok" });
  });

  it("bearerEnv overrides an Authorization header in static headers", () => {
    const got = buildHttpHeaders(
      {
        name: "x",
        url: "https://e",
        headers: { Authorization: "old" },
        bearerEnv: "MY_TOKEN",
      },
      { MY_TOKEN: "new" } as NodeJS.ProcessEnv,
    );
    expect(got.Authorization).toBe("Bearer new");
  });

  it("throws with clear message when bearerEnv env var is unset", () => {
    expect(() =>
      buildHttpHeaders({ name: "x", url: "https://e", bearerEnv: "MISSING_VAR" }, {}),
    ).toThrow(/bearerEnv "MISSING_VAR" is not set/);
  });

  it("throws when bearerEnv env var is empty string", () => {
    expect(() =>
      buildHttpHeaders(
        { name: "x", url: "https://e", bearerEnv: "EMPTY" },
        { EMPTY: "" } as NodeJS.ProcessEnv,
      ),
    ).toThrow(/bearerEnv "EMPTY" is not set/);
  });
});

describe("connectMcp (mocked transports)", () => {
  it("wires StdioClientTransport when command is set", async () => {
    const { connectMcp } = await import("./mcp.ts");
    const conn = await connectMcp({ name: "s", command: "echo", args: ["hi"] });
    expect(stdioCtor).toHaveBeenCalledTimes(1);
    expect(httpCtor).not.toHaveBeenCalled();
    expect(stdioCtor.mock.calls[0][0]).toMatchObject({ command: "echo", args: ["hi"] });
    expect(conn.tools).toHaveLength(1);
    expect(conn.tools[0].name).toBe("mcp.s.ping");
    await conn.close();
    expect(clientClose).toHaveBeenCalled();
  });

  it("wires StreamableHTTPClientTransport when url is set, with headers", async () => {
    const { connectMcp } = await import("./mcp.ts");
    process.env.__TEST_TOKEN = "abc123";
    try {
      const conn = await connectMcp({
        name: "h",
        url: "https://mcp.example.com/mcp",
        headers: { "X-Custom": "yes" },
        bearerEnv: "__TEST_TOKEN",
      });
      expect(httpCtor).toHaveBeenCalledTimes(1);
      expect(stdioCtor).not.toHaveBeenCalled();
      const [url, opts] = httpCtor.mock.calls[0] as [URL, { requestInit: { headers: Record<string, string> } }];
      expect(url.href).toBe("https://mcp.example.com/mcp");
      expect(opts.requestInit.headers).toEqual({
        "X-Custom": "yes",
        Authorization: "Bearer abc123",
      });
      await conn.close();
    } finally {
      delete process.env.__TEST_TOKEN;
    }
  });

  it("throws with clear message when bearerEnv is unset at connect time", async () => {
    const { connectMcp } = await import("./mcp.ts");
    delete process.env.__MISSING_TOKEN;
    await expect(
      connectMcp({ name: "h", url: "https://e/mcp", bearerEnv: "__MISSING_TOKEN" }),
    ).rejects.toThrow(/__MISSING_TOKEN/);
  });

  it("throws when both command and url set", async () => {
    const { connectMcp } = await import("./mcp.ts");
    await expect(
      connectMcp({ name: "x", command: "c", url: "https://e/mcp" }),
    ).rejects.toThrow(/both "command" and "url"/);
  });

  it("throws when neither command nor url set", async () => {
    const { connectMcp } = await import("./mcp.ts");
    await expect(connectMcp({ name: "x" } as McpServerConfig)).rejects.toThrow(
      /neither "command" nor "url"/,
    );
  });

  it("returned tool handler returns dryRun payload without calling client", async () => {
    const { connectMcp } = await import("./mcp.ts");
    const conn = await connectMcp({ name: "s", command: "echo" });
    const out = await conn.tools[0].handler({ x: 1 }, { dryRun: true } as any);
    expect(out).toEqual({ dryRun: true, would: { server: "s", tool: "ping", input: { x: 1 } } });
    expect(clientCallTool).not.toHaveBeenCalled();
  });

  it("returned tool handler forwards to client.callTool when live", async () => {
    const { connectMcp } = await import("./mcp.ts");
    const conn = await connectMcp({ name: "s", command: "echo" });
    const out = await conn.tools[0].handler({ x: 2 }, { dryRun: false } as any);
    expect(clientCallTool).toHaveBeenCalledWith({ name: "ping", arguments: { x: 2 } });
    expect(out).toEqual({ ok: true });
  });

  it("registers with hygiene ledger and marks completed on close", async () => {
    const { connectMcp } = await import("./mcp.ts");
    const { openHygiene } = await import("../runtime/hygiene.ts");
    const db = openHygiene(":memory:");
    const conn = await connectMcp({ name: "s", command: "echo" }, db);
    const row = db.prepare("SELECT kind, handle, status FROM resources").get() as any;
    expect(row).toMatchObject({ kind: "subprocess", handle: "mcp:s", status: "active" });
    await conn.close();
    const after = db.prepare("SELECT status FROM resources").get() as any;
    expect(after.status).toBe("completed");
  });

  it("registers http kind for URL transport", async () => {
    const { connectMcp } = await import("./mcp.ts");
    const { openHygiene } = await import("../runtime/hygiene.ts");
    const db = openHygiene(":memory:");
    const conn = await connectMcp({ name: "h", url: "https://e/mcp" }, db);
    const row = db.prepare("SELECT kind, handle FROM resources").get() as any;
    expect(row.kind).toBe("http_client");
    expect(row.handle).toBe("mcp:h:https://e/mcp");
    await conn.close();
  });

  it("swallows client.close errors", async () => {
    const { connectMcp } = await import("./mcp.ts");
    clientClose.mockRejectedValueOnce(new Error("boom"));
    const conn = await connectMcp({ name: "s", command: "echo" });
    await expect(conn.close()).resolves.toBeUndefined();
  });

  it("falls back to defaults when SDK tool lacks description/inputSchema", async () => {
    const { connectMcp } = await import("./mcp.ts");
    clientListTools.mockResolvedValueOnce({ tools: [{ name: "bare" }] } as any);
    const conn = await connectMcp({ name: "s", command: "echo" });
    expect(conn.tools[0].description).toMatch(/MCP tool bare on server s/);
    expect(conn.tools[0].inputSchema).toEqual({ type: "object" });
  });
});
