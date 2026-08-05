// Coworker inbox — plain markdown a human (or another coworker) can append
// to at any time. Read into every tick's perception under an "INBOX" section
// and shown to the model with priority ("read and consider before deciding").
//
// Path: coworkers/<name>/state/inbox.md
// Format: sections beginning "## <ISO ts>" followed by free markdown. Newest
// unread appears at the top of the injected block.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { scan } from "./injection.ts";

export interface Inbox {
  read(): string;                       // full raw file contents
  unread(): string;                     // messages not yet marked read
  markAllRead(): void;                  // move cursor to end
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
      // Guard against third parties writing to the inbox via a coworker's own
      // tool: scan and, if suspicious, wrap. Humans running note-to.sh are
      // implicitly trusted but the scan is cheap.
      const s = scan(slice);
      return s.suspicious ? s.redacted : slice;
    },
    markAllRead(): void {
      if (!existsSync(path)) return;
      const full = readFileSync(path, "utf8");
      writeCursor(full.length);
    },
  };
}
