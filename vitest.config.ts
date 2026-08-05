import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts and dashboard.ts are process entry-points — exercised via
      // integration/manual runs, not unit tests. Excluding them from the
      // gate prevents padding coverage with tests that assert little.
      exclude: [
        "src/**/*.test.ts",
        "src/index.ts",             // process entry-point
        "src/dashboard.ts",          // http server — manual
        "src/adapters/mcp.ts",       // spawns MCP subprocess; parseMcpEnv only
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        // Branches deliberately lower — many are defensive/JSON.parse fallback
        // arms exercised only in production. 75 keeps the gate honest without
        // rewarding branch-padding tests.
        branches: 75,
        // Statements fractionally lower than lines because tick.ts and
        // reflect.ts have clusters of defensive branches counted as
        // separate statements — same real behaviour is covered.
        statements: 88,
      },
    },
  },
});
