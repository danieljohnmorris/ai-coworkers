// Pre-flight check for every action call. BOUNDARIES.md is the source of truth;
// this module is only for hard, deterministic checks (resource caps, denylist
// patterns). Softer judgment ("should I really do this?") lives in the
// deliberation prompt, informed by the same BOUNDARIES.md text.

import type { Role } from "./role.ts";
import type { ToolDef, ToolCtx } from "./tools.ts";

export interface BoundaryDecision {
  allowed: boolean;
  reason?: string;
}

export function checkAction(
  role: Role,
  tool: ToolDef,
  input: unknown,
  _ctx: ToolCtx
): BoundaryDecision {
  // Hard rule: unknown tool → deny
  if (!tool) return { allowed: false, reason: "tool not registered" };

  // Hard rule: TOOLS.md must permit this tool
  const allowedList = allowedToolNames(role.docs.TOOLS);
  const permitted = allowedList.some(
    (p) => tool.name === p || tool.name.startsWith(p + ".")
  );
  if (!permitted) {
    return { allowed: false, reason: `${tool.name} not declared in TOOLS.md` };
  }

  // Field-scoped allowlist: if BOUNDARIES.md declares an allowlist for this
  // tool, any top-level input key outside the list is blocked. Nested object
  // values under an allowed key are NOT recursed — the allowlist gates the
  // API surface (which fields the tool touches), not their contents. Deep
  // content is still subject to the denylist scan below.
  const fieldAllow = fieldAllowlist(role.docs.BOUNDARIES, tool.name);
  if (fieldAllow && input && typeof input === "object" && !Array.isArray(input)) {
    for (const key of Object.keys(input as Record<string, unknown>)) {
      if (!fieldAllow.includes(key)) {
        return {
          allowed: false,
          reason: `field '${key}' not in allowlist for ${tool.name}`,
        };
      }
    }
  }

  // AIC-49 — Word-boundary denylist scan (was naive substring; "billing"
  // used to match "billion"). Skip tokens shorter than 3 chars to avoid
  // over-blocking on common English fragments.
  const forbidden = mustNotTouch(role.docs.BOUNDARIES);
  if (forbidden.length) {
    const blob = JSON.stringify(input).toLowerCase();
    for (const raw of forbidden) {
      const f = raw?.trim();
      if (!f || f.length < 3) continue;
      const escaped = f.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, "i");
      if (re.test(blob)) {
        return { allowed: false, reason: `input mentions forbidden target: ${f}` };
      }
    }
  }

  return { allowed: true };
}

// Parse a field-scoped allowlist for a specific tool from BOUNDARIES.md.
// Convention: under a heading matching /field allowlist/i, a bullet line of
// the form `- <tool.name>: <field>, <field>` declares which top-level input
// keys are permitted. Returns `undefined` when no allowlist applies to this
// tool (i.e. no gate) and `[]` when the tool is explicitly restricted to no
// fields (empty input only).
function fieldAllowlist(
  boundariesMd: string,
  toolName: string
): string[] | undefined {
  if (!boundariesMd) return undefined;
  const lines = boundariesMd.split(/\r?\n/);
  let capturing = false;
  for (const line of lines) {
    if (/^#+\s+/.test(line)) {
      capturing = /field\s+allowlist/i.test(line);
      continue;
    }
    if (!capturing) continue;
    const m = line.match(/^-\s+`?([a-z][a-z0-9_.]*)`?\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    if (m[1] !== toolName) continue;
    return m[2]
      .split(",")
      .map((s) => s.trim().replace(/^`|`$/g, ""))
      .filter(Boolean);
  }
  return undefined;
}

function allowedToolNames(toolsMd: string): string[] {
  return [...toolsMd.matchAll(/^-\s*([a-z][a-z0-9_.]*)/gim)].map((m) => m[1]);
}

// Extract quoted or bulleted forbidden targets from a "must not" section.
// Best-effort: looks for bullet lines under a heading mentioning "not touch",
// "never", "forbidden", or "do not".
function mustNotTouch(boundariesMd: string): string[] {
  if (!boundariesMd) return [];
  const lines = boundariesMd.split(/\r?\n/);
  const out: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (/^#+\s+/.test(line)) {
      capturing = /(not touch|never|forbidden|do not)/i.test(line);
      continue;
    }
    if (capturing) {
      const m = line.match(/^-\s+(.+?)\s*$/);
      if (m) out.push(m[1]);
    }
  }
  return out;
}
