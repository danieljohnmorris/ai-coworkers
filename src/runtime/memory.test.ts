import { describe, it, expect, beforeEach } from "vitest";
import { openMemory, addPromise, pendingPromises, setPromiseStatus, recentRollups } from "./memory.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mem-")); });

describe("memory.db", () => {
  it("addPromise then pendingPromises returns it", () => {
    const db = openMemory(join(dir, "m.db"));
    const id = addPromise(db, "trig", "act", null);
    const p = pendingPromises(db, new Date());
    expect(p.length).toBe(1);
    expect(p[0].id).toBe(id);
    rmSync(dir, { recursive: true, force: true });
  });

  it("filters promises by fire_after", () => {
    const db = openMemory(join(dir, "m.db"));
    const future = new Date(Date.now() + 3600_000);
    addPromise(db, "trig", "act", future);
    expect(pendingPromises(db, new Date()).length).toBe(0);
    expect(pendingPromises(db, new Date(future.getTime() + 1000)).length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("setPromiseStatus removes from pending", () => {
    const db = openMemory(join(dir, "m.db"));
    const id = addPromise(db, "t", "a", null);
    setPromiseStatus(db, id, "fired");
    expect(pendingPromises(db, new Date()).length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("recentRollups returns most recent first", () => {
    const db = openMemory(join(dir, "m.db"));
    db.prepare("INSERT INTO rollups (period, period_start, period_end, body) VALUES ('week', ?, ?, ?)")
      .run("a", "b", "first");
    db.prepare("INSERT INTO rollups (period, period_start, period_end, body) VALUES ('week', ?, ?, ?)")
      .run("a", "b", "second");
    const r = recentRollups(db, 5);
    expect(r[0].body).toBe("second");
    rmSync(dir, { recursive: true, force: true });
  });
});
