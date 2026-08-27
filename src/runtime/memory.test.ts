import { describe, it, expect, beforeEach } from "vitest";
import { openMemory, addPromise, pendingPromises, setPromiseStatus, recentRollups, recordDecision, eventIdsResolve } from "./memory.ts";
import { openEvents, Log } from "./log.ts";
import { DatabaseSync } from "node:sqlite";
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

describe("AIC-128 ladder schema migration", () => {
  it("migrates a pre-ladder database in place, leaving legacy rows NULL", () => {
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE rollups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period TEXT NOT NULL, period_start TEXT NOT NULL,
        period_end TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE TABLE decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, summary TEXT NOT NULL, rationale TEXT
      );
      INSERT INTO rollups (period, period_start, period_end, body) VALUES ('week', 'a', 'b', 'legacy rollup');
      INSERT INTO decisions (ts, summary, rationale) VALUES ('t', 'legacy call', 'because');
    `);
    old.close();

    const db = openMemory(path);
    const r = db.prepare("SELECT * FROM rollups").get() as Record<string, unknown>;
    expect(r.body).toBe("legacy rollup");
    expect(r.level).toBeNull();
    expect(r.parent_id).toBeNull();
    expect(r.source_range).toBeNull();
    const d = db.prepare("SELECT * FROM decisions").get() as Record<string, unknown>;
    expect(d.summary).toBe("legacy call");
    expect(d.source_events).toBeNull();
    db.close();

    // Reopening is a no-op — the pragma guard must not re-ALTER.
    const again = openMemory(path);
    const count = again.prepare("SELECT COUNT(*) AS n FROM rollups").get() as Record<string, unknown>;
    expect(count.n).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fresh databases get the ladder columns from CREATE TABLE", () => {
    const db = openMemory(join(dir, "fresh.db"));
    db.prepare(`INSERT INTO rollups (period, period_start, period_end, body, level, parent_id, source_range)
                VALUES ('day', 'a', 'b', 'x', 1, NULL, '[1,2]')`).run();
    const r = db.prepare("SELECT level, source_range FROM rollups").get() as Record<string, unknown>;
    expect(r.level).toBe(1);
    expect(r.source_range).toBe("[1,2]");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("AIC-128 decision provenance (recordDecision)", () => {
  function seedEvents(n: number): DatabaseSync {
    const events = openEvents(join(dir, "e.db"));
    const ins = events.prepare("INSERT INTO events (ts, coworker, kind, payload) VALUES (?, 't', 'action', '{}')");
    for (let i = 0; i < n; i++) ins.run(new Date().toISOString());
    return events;
  }

  it("stores resolving source event ids as a JSON array", () => {
    const events = seedEvents(3);
    const memory = openMemory(join(dir, "m.db"));
    const id = recordDecision(memory, events, { summary: "s", rationale: "r", sourceEventIds: [1, 2, 3] });
    const d = memory.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Record<string, unknown>;
    expect(d.summary).toBe("s");
    expect(d.source_events).toBe("[1,2,3]");
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves ids that live only in events_archive", () => {
    const events = openEvents(join(dir, "e.db"));
    events.prepare("INSERT INTO events_archive (id, ts, coworker, kind, payload) VALUES (7, 't', 't', 'action', '{}')").run();
    const memory = openMemory(join(dir, "m.db"));
    const id = recordDecision(memory, events, { summary: "s", sourceEventIds: [7] });
    const d = memory.prepare("SELECT source_events FROM decisions WHERE id = ?").get(id) as Record<string, unknown>;
    expect(d.source_events).toBe("[7]");
    rmSync(dir, { recursive: true, force: true });
  });

  it("caps overflow past 200 ids by storing the min/max span", () => {
    const events = seedEvents(201);
    const memory = openMemory(join(dir, "m.db"));
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    const id = recordDecision(memory, events, { summary: "s", sourceEventIds: ids });
    const d = memory.prepare("SELECT source_events FROM decisions WHERE id = ?").get(id) as Record<string, unknown>;
    expect(d.source_events).toBe(JSON.stringify({ span: [1, 201] }));
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes NULL and logs memory.compact when an id does not resolve", () => {
    const events = seedEvents(1);
    const memory = openMemory(join(dir, "m.db"));
    const id = recordDecision(memory, events, {
      summary: "s", sourceEventIds: [1, 999], log: new Log(events, "t"),
    });
    const d = memory.prepare("SELECT source_events FROM decisions WHERE id = ?").get(id) as Record<string, unknown>;
    expect(d.source_events).toBeNull();
    const logged = events.prepare("SELECT payload FROM events WHERE kind = 'memory.compact'").all() as { payload: string }[];
    expect(logged.length).toBe(1);
    expect(logged[0].payload).toContain("did not resolve");
    rmSync(dir, { recursive: true, force: true });
  });

  it("eventIdsResolve rejects empty and non-integer id lists", () => {
    const events = seedEvents(1);
    expect(eventIdsResolve(events, [])).toBe(false);
    expect(eventIdsResolve(events, [1.5])).toBe(false);
    expect(eventIdsResolve(events, [1])).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
