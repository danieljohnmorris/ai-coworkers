// Hermes / OpenClaw / Anthropic-style skills adapter.
//
// These skills are NOT callable tools — they are folders containing a
// SKILL.md (front-matter + prose) that the model reads *in-context* to know
// when and how to invoke behaviour. So the correct adapter is:
//
//   - Scan the skills dir
//   - Parse each SKILL.md's front-matter (name, description) + body
//   - Return a summary that gets appended to the coworker's system prompt
//     as procedural memory ("Skills you have access to").
//
// Any executable side of a skill (scripts, tools) is loaded separately via
// our normal tool registry — most Hermes skills are pure prompt-augmentation.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface HermesSkill {
  name: string;
  description: string;
  path: string;
  body: string;
}

export function loadHermesSkills(dir: string): HermesSkill[] {
  if (!existsSync(dir)) return [];
  const skills: HermesSkill[] = [];
  for (const entry of readdirSync(dir)) {
    const skillDir = join(dir, entry);
    if (!statSync(skillDir).isDirectory()) continue;
    const md = join(skillDir, "SKILL.md");
    if (!existsSync(md)) continue;
    const raw = readFileSync(md, "utf8");
    const { name, description, body } = parseFrontMatter(raw, entry);
    skills.push({ name, description, path: skillDir, body });
  }
  return skills;
}

// Compose the procedural-memory section for the system prompt. Kept terse —
// only names + descriptions for most skills, so the model can request full
// context if needed. Skills listed in `activeNames` get their full body
// inlined (use for always-on style skills like caveman-mode).
export function renderSkillsIndex(skills: HermesSkill[], activeNames: string[] = []): string {
  if (!skills.length) return "";
  const active = new Set(activeNames);
  const lines: string[] = [
    "# SKILLS (procedural memory — instructions and playbooks you can consult)",
    "",
    ...skills.map((s) => `- **${s.name}** — ${s.description}`),
  ];
  const activated = skills.filter((s) => active.has(s.name));
  if (activated.length) {
    lines.push("", "## Active skills (apply their rules to every response)");
    for (const s of activated) {
      lines.push("", `### ${s.name}`, "", s.body);
    }
  }
  return lines.join("\n");
}

function parseFrontMatter(raw: string, fallbackName: string): {
  name: string; description: string; body: string;
} {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { name: fallbackName, description: firstLine(raw), body: raw };
  const fm = Object.fromEntries(
    m[1].split(/\r?\n/).map((line) => {
      const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
      return kv ? [kv[1].toLowerCase(), kv[2].trim().replace(/^["']|["']$/g, "")] : ["", ""];
    }).filter(([k]) => k)
  );
  return {
    name: fm.name || fallbackName,
    description: fm.description || firstLine(m[2]),
    body: m[2].trim(),
  };
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "").slice(0, 200);
}
