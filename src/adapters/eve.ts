// Vercel Eve `agent/` folder compatibility. Eve organises an agent as:
//   agent/
//     instructions.md      persona + system prompt
//     tools/*.ts           tool definitions
//     skills/*.md          on-demand loaded skills
//     channels/            message transports
//     schedules/           cron-like
//     connections/         OAuth/API auth
//
// We map this onto our shape:
//   agent/instructions.md      → our role/ROLE.md (+ appended to system prompt)
//   agent/skills/*.md          → procedural memory index (via hermes.ts renderer)
//   agent/tools/*.ts           → require developer effort to port to our ToolDef;
//                                for now we surface the list so it's visible.
//
// Non-goal: replicating Eve's Workflows runtime. This is a read-in of the
// filesystem convention only.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadHermesSkills, type HermesSkill } from "./hermes.ts";

export interface EveAgent {
  root: string;
  instructions: string;                    // contents of instructions.md
  skills: HermesSkill[];                   // skills/*.md
  toolFiles: string[];                     // tools/*.ts (unbound; listed only)
  channels: string[];                      // channels/*
  schedules: string[];                     // schedules/*
}

export function loadEveAgent(root: string): EveAgent | null {
  if (!existsSync(root)) return null;
  const readList = (sub: string): string[] =>
    existsSync(join(root, sub)) ? readdirSync(join(root, sub)) : [];
  const instructionsPath = join(root, "instructions.md");
  return {
    root,
    instructions: existsSync(instructionsPath) ? readFileSync(instructionsPath, "utf8") : "",
    skills: loadHermesSkills(join(root, "skills")),
    toolFiles: readList("tools").filter((f) => f.endsWith(".ts") || f.endsWith(".js")),
    channels: readList("channels"),
    schedules: readList("schedules"),
  };
}
