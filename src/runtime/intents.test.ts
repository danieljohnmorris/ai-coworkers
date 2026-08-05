import { describe, it, expect, beforeEach } from "vitest";
import { matchIntents } from "./intents.ts";
import { openMemory, addPromise, pendingPromises } from "./memory.ts";
import { openEvents } from "./log.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "int-")); });

function seedEvent(db: any, kind: string, payload: object) {
  db.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, ?, ?, ?)")
    .run(new Date().toISOString(), "t", kind, JSON.stringify(payload));
}

describe("matchIntents", () => {
  it("no promises → no fires", () => {
    const memory = openMemory(join(dir, "m.db"));
    const events = openEvents(join(dir, "e.db"));
    expect(matchIntents(memory, events)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fires when identifier in trigger matches an event payload", () => {
    const memory = openMemory(join(dir, "m.db"));
    const events = openEvents(join(dir, "e.db"));
    const id = addPromise(memory, "reply on ILO-42", "follow up on ILO-42", null);
    seedEvent(events, "action", { tool: "linear.comment", input: { issueId: "ILO-42" } });
    const fired = matchIntents(memory, events);
    expect(fired.length).toBe(1);
    expect(fired[0].id).toBe(id);
    expect(pendingPromises(memory, new Date())).toEqual([]); // marked fired
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not fire without a matching identifier or keyword", () => {
    const memory = openMemory(join(dir, "m.db"));
    const events = openEvents(join(dir, "e.db"));
    addPromise(memory, "reply on ILO-99", "x", null);
    seedEvent(events, "action", { tool: "linear.comment", input: { issueId: "ILO-42" } });
    expect(matchIntents(memory, events)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fires on keyword ('reply') when no identifier in trigger", () => {
    const memory = openMemory(join(dir, "m.db"));
    const events = openEvents(join(dir, "e.db"));
    addPromise(memory, "wait for a reply from anyone", "follow up", null);
    seedEvent(events, "note", { message: "there was a reply on some ticket" });
    const fired = matchIntents(memory, events);
    expect(fired.length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
