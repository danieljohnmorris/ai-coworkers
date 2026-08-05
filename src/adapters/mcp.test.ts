import { describe, it, expect } from "vitest";
import { parseMcpEnv } from "./mcp.ts";

describe("parseMcpEnv", () => {
  it("returns [] when unset", () => {
    expect(parseMcpEnv({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("returns [] on malformed json", () => {
    expect(parseMcpEnv({ MCP_SERVERS: "not json" } as unknown as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("parses well-formed configs", () => {
    const raw = JSON.stringify([
      { name: "github", command: "npx", args: ["@modelcontextprotocol/server-github"] },
      { name: "fs", command: "mcp-server-fs" },
    ]);
    const got = parseMcpEnv({ MCP_SERVERS: raw } as unknown as NodeJS.ProcessEnv);
    expect(got.length).toBe(2);
    expect(got[0].name).toBe("github");
    expect(got[1].args).toBeUndefined();
  });

  it("filters entries missing name or command", () => {
    const raw = JSON.stringify([{ name: "x" }, { command: "y" }, { name: "ok", command: "cmd" }]);
    const got = parseMcpEnv({ MCP_SERVERS: raw } as unknown as NodeJS.ProcessEnv);
    expect(got.length).toBe(1);
    expect(got[0].name).toBe("ok");
  });
});
