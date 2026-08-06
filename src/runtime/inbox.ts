// Coworker inbox — plain markdown a human (or another coworker) can append
// to at any time. Read into every tick's perception under an "INBOX" section
// and shown to the model with priority ("read and consider before deciding").
//
// Path: coworkers/<name>/state/inbox.md
// Format: sections beginning "## <ISO ts>" followed by free markdown. Newest
// unread appears at the top of the injected block.
//
// AIC-57 — signed notes for shared boxes. Each note appended by note-to.sh
// with NOTE_HMAC_SECRET set carries a trailer:
//   <!-- sig:<base64> sender:<name> ts:<iso> -->
// We verify against NOTE_HMAC_SECRET in the coworker's env. Unsigned or
// bad-signature notes get a [UNSIGNED] prefix in the model-facing form;
// with NOTE_REQUIRE_SIGNED=1, they are dropped entirely.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { scan } from "./injection.ts";

export interface Inbox {
  read(): string;                       // full raw file contents
  unread(): string;                     // messages not yet marked read (verified)
  markAllRead(): void;                  // move cursor to end
}

interface Note {
  header: string;                       // "## 2026-… — from alice"
  body: string;                         // note body sans trailer
  sig?: string;                         // base64 HMAC-SHA256
  sender?: string;
  ts?: string;
}

// Split a raw inbox slice into notes on "## " headings.
function parseNotes(slice: string): Note[] {
  if (!slice.trim()) return [];
  const notes: Note[] = [];
  const parts = slice.split(/(?=^## )/m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const lines = part.split(/\r?\n/);
    const header = lines[0] ?? "";
    if (!header.startsWith("## ")) continue;
    let sig: string | undefined, sender: string | undefined, ts: string | undefined;
    const bodyLines: string[] = [];
    for (const line of lines.slice(1)) {
      const m = line.match(/^<!-- sig:(\S+)\s+sender:(\S*)\s+ts:(\S+)\s*-->\s*$/);
      if (m) { sig = m[1]; sender = m[2]; ts = m[3]; continue; }
      bodyLines.push(line);
    }
    // Strip trailing blank lines from body
    while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();
    notes.push({ header, body: bodyLines.join("\n"), sig, sender, ts });
  }
  return notes;
}

function verify(note: Note, secret: string): boolean {
  if (!note.sig || !note.ts) return false;
  const payload = `${note.sender ?? ""}|${note.ts}|${note.body}`;
  const expected = createHmac("sha256", secret).update(payload).digest("base64");
  // timingSafeEqual requires equal-length inputs.
  const a = Buffer.from(note.sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

function renderNote(note: Note, verified: boolean, secretSet: boolean): string {
  const prefix = !secretSet ? "" : verified ? "" : "[UNSIGNED] ";
  return `${prefix}${note.header}\n${note.body}\n\n`;
}

// Cursor is a companion file so we don't rewrite inbox.md on every read.
export function openInbox(path: string): Inbox {
  const cursorPath = path + ".cursor";
  const readCursor = (): number => {
    if (!existsSync(cursorPath)) return 0;
    const n = Number(readFileSync(cursorPath, "utf8").trim());
    return Number.isFinite(n) ? n : 0;
  };
  const writeCursor = (n: number) => writeFileSync(cursorPath, String(n));

  return {
    read(): string {
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    },
    unread(): string {
      if (!existsSync(path)) return "";
      const full = readFileSync(path, "utf8");
      const from = readCursor();
      const slice = full.slice(from);
      if (!slice.trim()) return "";

      const secret = process.env.NOTE_HMAC_SECRET;
      const requireSigned = process.env.NOTE_REQUIRE_SIGNED === "1";
      const notes = parseNotes(slice);
      const rendered: string[] = [];
      for (const n of notes) {
        const verified = secret ? verify(n, secret) : false;
        if (secret && requireSigned && !verified) continue;   // drop entirely
        rendered.push(renderNote(n, verified, Boolean(secret)));
      }
      const combined = rendered.join("");
      if (!combined.trim()) return "";
      // Injection scan still applies — humans running note-to.sh are
      // implicitly trusted, but content coming through a forwarder may not be.
      const s = scan(combined);
      return s.suspicious ? s.redacted : combined;
    },
    markAllRead(): void {
      if (!existsSync(path)) return;
      const full = readFileSync(path, "utf8");
      writeCursor(full.length);
    },
  };
}
