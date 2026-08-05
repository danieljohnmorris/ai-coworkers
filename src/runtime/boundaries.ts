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

  // String denylist scan against BOUNDARIES.md "must not touch" phrases.
  // If any forbidden token appears in the JSON of input, block.
  const forbidden = mustNotTouch(role.docs.BOUNDARIES);
  if (forbidden.length) {
    const blob = JSON.stringify(input).toLowerCase();
    for (const f of forbidden) {
      if (f && blob.includes(f.toLowerCase())) {
        return { allowed: false, reason: `input mentions forbidden target: ${f}` };
      }
    }
  }

  return { allowed: true };
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
