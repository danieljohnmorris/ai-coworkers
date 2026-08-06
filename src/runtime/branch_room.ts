// AIC-72 — branch-as-room. Each git branch a coworker acts on gets a
// running markdown narrative at coworkers/<name>/state/branches/<branch>.md
// that accumulates patches, CI outcomes, review notes, and merge decisions.
// The file becomes the record of why the code exists — the same idea as
// Buzz's NIP-34 "feature branch spawns a channel", but stored on the
// filesystem so the existing tail/grep workflow still works.
//
// This module owns storage. The tools in src/tools/branch_room.ts expose
// append/read/list to the coworker, and future work (a github/git watcher
// sensor) can auto-seed rooms when new branches appear.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";

export type EntryKind = "patch" | "ci" | "review" | "note" | "merge" | "close";

export interface BranchEntry {
  ts: string;
  kind: EntryKind;
  by: string;             // who wrote it — coworker name, "human", or a source system ("github", "ci")
  body: string;           // free markdown; kept short-ish (append to it, don't rewrite)
}

export interface BranchRoom {
  ensure(branch: string): void;
  append(branch: string, entry: Omit<BranchEntry, "ts"> & { ts?: string }): void;
  read(branch: string): string;                       // full raw file
  list(): { branch: string; path: string; sizeBytes: number; updatedAt: string }[];
  path(branch: string): string;
}

// Branch names allowed on disk. Slashes are common in git (`feat/foo`),
// but we flatten them to keep one file per branch and avoid nested dirs.
export function sanitizeBranch(branch: string): string {
  // Reject path-traversal attempts in the ORIGINAL name — a `..` segment
  // survives our slash-flattening and would land in a `.` char class.
  if (branch.split(/[/\\]/).some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new Error(`invalid branch name for room storage: ${branch}`);
  }
  const flat = branch.replace(/[/\\]/g, "__");
  if (!/^[a-zA-Z0-9._-]+$/.test(flat)) {
    throw new Error(`invalid branch name for room storage: ${branch}`);
  }
  return flat;
}

export function openBranchRoom(baseDir: string): BranchRoom {
  const filePath = (branch: string): string => join(baseDir, `${sanitizeBranch(branch)}.md`);

  return {
    path: filePath,

    ensure(branch: string): void {
      const p = filePath(branch);
      if (existsSync(p)) return;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, headerFor(branch));
    },

    append(branch, entry): void {
      const p = filePath(branch);
      if (!existsSync(p)) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, headerFor(branch));
      }
      const ts = entry.ts ?? new Date().toISOString();
      const block = renderEntry({ ts, kind: entry.kind, by: entry.by, body: entry.body });
      appendFileSync(p, block);
    },

    read(branch: string): string {
      const p = filePath(branch);
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    },

    list() {
      if (!existsSync(baseDir)) return [];
      return readdirSync(baseDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => {
          const p = join(baseDir, f);
          const s = statSync(p);
          return {
            branch: basename(f, ".md").replace(/__/g, "/"),
            path: p,
            sizeBytes: s.size,
            updatedAt: s.mtime.toISOString(),
          };
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  };
}

function headerFor(branch: string): string {
  return `# Branch: ${branch}\n\nOpened ${new Date().toISOString()}. Everything that happens on this branch — patches, CI, review, merge — lands here.\n\n`;
}

function renderEntry(e: BranchEntry): string {
  const icon: Record<EntryKind, string> = {
    patch: "🩹", ci: "🧪", review: "🔍", note: "🗒️", merge: "🔀", close: "🚫",
  };
  return `## ${icon[e.kind] ?? ""} ${e.kind} — ${e.ts.slice(0, 19).replace("T", " ")} · by ${e.by}\n\n${e.body.trim()}\n\n`;
}
