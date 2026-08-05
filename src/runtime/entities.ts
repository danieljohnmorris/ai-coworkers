// Entity memory — per-person and per-project markdown files. Populated by
// the coworker (and by humans) over time. Loaded into perception when the
// entity is mentioned in sensor output, so the coworker recalls "Dan prefers
// small PRs" or "ILO-509 was already discussed last week".
//
// Layout:
//   coworkers/<name>/state/entities/people/<handle>.md
//   coworkers/<name>/state/entities/projects/<key>.md
//
// Writes go through the injection scanner (third-party text is untrusted).

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { scan } from "./injection.ts";

const HANDLE_ALLOW = /^[a-zA-Z0-9._-]+$/;

export interface EntityStore {
  people(): string[];                                     // list of handles present
  projects(): string[];                                   // list of project keys present
  readPerson(handle: string): string;
  readProject(key: string): string;
  upsertPerson(handle: string, body: string, source: string): { accepted: boolean; reason: string };
  upsertProject(key: string, body: string, source: string): { accepted: boolean; reason: string };
  // Given a blob of text (e.g. a JSON-encoded perception), return the entities
  // that are mentioned — used to decide what to inject into the prompt.
  detect(text: string): { people: string[]; projects: string[] };
}

const CAP = 4096;

export function openEntities(root: string): EntityStore {
  const peopleDir = join(root, "people");
  const projectsDir = join(root, "projects");
  mkdirSync(peopleDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });

  const list = (dir: string): string[] =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => basename(f, ".md"));

  const read = (dir: string, key: string): string => {
    if (!HANDLE_ALLOW.test(key)) return "";
    const p = join(dir, `${key}.md`);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  };

  const upsert = (dir: string, key: string, body: string, source: string) => {
    if (!HANDLE_ALLOW.test(key)) return { accepted: false, reason: `invalid key: ${key}` };
    if (body.length > CAP) return { accepted: false, reason: `exceeds cap ${CAP}` };
    const s = scan(body);
    if (s.suspicious) return { accepted: false, reason: `flagged: ${s.hits.join(",")}` };
    const p = join(dir, `${key}.md`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `<!-- last updated: ${new Date().toISOString()} from ${source} -->\n${body}\n`);
    return { accepted: true, reason: "written" };
  };

  return {
    people: () => list(peopleDir),
    projects: () => list(projectsDir),
    readPerson: (h) => read(peopleDir, h),
    readProject: (k) => read(projectsDir, k),
    upsertPerson: (h, body, src) => upsert(peopleDir, h, body, src),
    upsertProject: (k, body, src) => upsert(projectsDir, k, body, src),
    detect(text) {
      // AIC-37 — identity clustering. Read each person file's YAML-ish
      // frontmatter `aliases: [dan, @dan_slack, daniel@…]` and treat all
      // aliases as the same person for detection purposes. Returns the
      // canonical handle (filename without .md) on a hit against any alias.
      const people: string[] = [];
      for (const canonical of list(peopleDir)) {
        const body = read(peopleDir, canonical);
        const identities = new Set<string>([canonical, ...extractAliases(body)]);
        if ([...identities].some((h) => h && text.includes(h))) {
          people.push(canonical);
        }
      }
      const projects = list(projectsDir).filter(
        (k) => new RegExp(`\\b${k}(?:-\\d+)?\\b`).test(text)
      );
      return { people, projects };
    },
  };
}

// Parse the `aliases: [x, y, z]` line out of a markdown frontmatter block.
// Tolerant of the surrounding HTML comment we write in upsertPerson.
function extractAliases(body: string): string[] {
  const m = body.match(/^\s*aliases:\s*\[([^\]]+)\]/im);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}
