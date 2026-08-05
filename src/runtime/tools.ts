// Tool registry. Each tool is either a sensor (read-only, gathered every tick)
// or an action (write, requires authority + boundary check).
// Tools declare a name, description, JSON schema, and a handler.

export interface ToolDef<TInput = unknown, TOutput = unknown> {
  name: string;                                   // e.g. "linear.new_issues"
  kind: "sensor" | "action";
  description: string;                            // shown to the model
  inputSchema: object;                            // JSON schema for arguments
  handler: (input: TInput, ctx: ToolCtx) => Promise<TOutput>;
}

export interface ToolCtx {
  coworker: string;
  dryRun: boolean;                                // action tools should honor this
  env: NodeJS.ProcessEnv;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  sensors(): ToolDef[] {
    return [...this.tools.values()].filter((t) => t.kind === "sensor");
  }

  actions(): ToolDef[] {
    return [...this.tools.values()].filter((t) => t.kind === "action");
  }

  // Filter registry to what the coworker's TOOLS.md declares.
  // TOOLS.md format: bullet lines like "- linear: read/write issues" — we
  // match tools by prefix (e.g. "linear.*"). Missing declaration = no access.
  scopedTo(toolsMd: string): string[] {
    const allowed = new Set<string>();
    const prefixes = [...toolsMd.matchAll(/^-\s*([a-z][a-z0-9_.]*)/gim)].map((m) => m[1]);
    for (const t of this.tools.keys()) {
      if (prefixes.some((p) => t === p || t.startsWith(p + "."))) allowed.add(t);
    }
    return [...allowed];
  }
}
