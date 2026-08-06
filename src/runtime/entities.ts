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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { scan } from "./injection.ts";

const HANDLE_ALLOW = /^[a-zA-Z0-9._-]+$/;

export type EntityKind = "person" | "project";

export interface EntityRef { kind: EntityKind; key: string }

// AIC-55 — RELATIONSHIP edges. A directed edge from one entity to another
// with a labelled type. Kept minimal (no properties/weights): the type
// string is the meaning ("works_on", "reviews", "reports_to", "owns",
// "blocks", etc.), the note is a free-text human hint.
export interface Edge {
  from: EntityRef;
  to: EntityRef;
  type: string;
  ts: string;
  note?: string;
}

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
  // AIC-55 — relationships.
  relate(edge: Omit<Edge, "ts"> & { ts?: string }): { accepted: boolean; reason: string };
  edgesFor(ref: EntityRef): Edge[];
}

const CAP = 4096;

export function openEntities(root: string): EntityStore {
  const peopleDir = join(root, "people");
  const projectsDir = join(root, "projects");
  const edgesPath = join(root, "relationships.jsonl");
  mkdirSync(peopleDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });

  const validRef = (r: EntityRef): boolean =>
    (r.kind === "person" || r.kind === "project") && HANDLE_ALLOW.test(r.key);

  const readEdges = (): Edge[] => {
    if (!existsSync(edgesPath)) return [];
    const out: Edge[] = [];
    for (const line of readFileSync(edgesPath, "utf8").split("\n")) {
      const t = line.trim(); if (!t) continue;
      try { out.push(JSON.parse(t) as Edge); } catch { /* skip */ }
    }
    return out;
  };

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

    relate(edge) {
      if (!validRef(edge.from) || !validRef(edge.to)) return { accepted: false, reason: "invalid ref (kind or key)" };
      if (!edge.type || typeof edge.type !== "string" || edge.type.length > 60) return { accepted: false, reason: "type must be 1..60 chars" };
      if (edge.note && edge.note.length > 500) return { accepted: false, reason: "note too long (>500 chars)" };
      if (edge.note) {
        const s = scan(edge.note);
        if (s.suspicious) return { accepted: false, reason: `note flagged: ${s.hits.join(",")}` };
      }
      const record: Edge = { ...edge, ts: edge.ts ?? new Date().toISOString() };
      appendFileSync(edgesPath, JSON.stringify(record) + "\n");
      return { accepted: true, reason: "written" };
    },

    edgesFor(ref) {
      if (!validRef(ref)) return [];
      const same = (a: EntityRef, b: EntityRef) => a.kind === b.kind && a.key === b.key;
      return readEdges().filter((e) => same(e.from, ref) || same(e.to, ref));
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
