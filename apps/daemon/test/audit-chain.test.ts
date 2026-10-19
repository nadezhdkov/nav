import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NewEvent } from "@navarch/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
import { EventStore } from "../src/events/store.ts";

const sys = { kind: "system", component: "test" } as const;
const note = (n: number): NewEvent => ({ type: "project.removed", run_id: null, task_id: null, actor: sys, payload: { project_id: `prj_${n}` } }) as NewEvent;

let path: string;
let store: EventStore;
beforeEach(() => {
  path = join(tempHome(), "navarch.db");
  store = new EventStore(path);
});
afterEach(() => store.close());

/** Edits the log the way an attacker with the file would: by dropping the append-only triggers first. */
function tamper(sql: string): void {
  const db = new DatabaseSync(path);
  db.exec("DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;");
  db.exec(sql);
  db.close();
}

describe("the event log's hash chain", () => {
  it("holds for a log written by the store, across batches", () => {
    store.append([note(1), note(2)]);
    store.append([note(3)]);
    const r = store.verifyChain();
    expect(r).toMatchObject({ ok: true, events: 3, chained: 3, legacy: 0, broken: null });
    expect(r.head).toMatch(/^[0-9a-f]{64}$/);
    expect(store.hasHash(r.head!)).toBe(true);
    expect(store.hasHash("0".repeat(64))).toBe(false);
  });

  it("is empty and fine for a new log", () => {
    expect(store.verifyChain()).toMatchObject({ ok: true, events: 0, head: null });
  });

  it("finds an edited event, and says where", () => {
    store.append([note(1), note(2), note(3)]);
    store.close();
    tamper(`UPDATE events SET payload = '{"project_id":"prj_x"}' WHERE seq = 2`);
    store = new EventStore(path);
    const r = store.verifyChain();
    expect(r.ok).toBe(false);
    expect(r.broken?.seq).toBe(2);
  });

  it("finds a removed event in the middle and one with its hash cut out", () => {
    store.append([note(1), note(2), note(3)]);
    store.close();
    tamper("DELETE FROM events WHERE seq = 2");
    store = new EventStore(path);
    expect(store.verifyChain().broken?.seq).toBe(3);
    store.close();
    tamper("UPDATE events SET hash = NULL WHERE seq = 3");
    store = new EventStore(path);
    expect(store.verifyChain()).toMatchObject({ ok: false, broken: { seq: 3 } });
  });

  it("notices a removed last event only by the head the user kept", () => {
    store.append([note(1), note(2)]);
    const kept = store.verifyChain().head!;
    store.close();
    // Dropping the newest event leaves a chain that is consistent by itself: only the kept head shows it.
    tamper("DELETE FROM events WHERE seq = 2");
    store = new EventStore(path);
    store.append([note(9)]);
    expect(store.verifyChain().ok).toBe(true);
    expect(store.hasHash(kept)).toBe(false);
  });

  it("starts the chain after events written before it existed, which stay uncovered", () => {
    store.close();
    // A log from before the chain: the column is missing and the events have no hash.
    const db = new DatabaseSync(path);
    db.exec("DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete; ALTER TABLE events DROP COLUMN hash;");
    db.exec(`INSERT INTO events (id, ts, type, run_id, task_id, actor, payload, schema_version) VALUES ('evt_old', '2026-01-01T00:00:00.000Z', 'project.removed', NULL, NULL, '{"kind":"system","component":"test"}', '{"project_id":"prj_old"}', 1)`);
    db.close();
    store = new EventStore(path);
    store.append([note(1)]);
    expect(store.verifyChain()).toMatchObject({ ok: true, events: 2, legacy: 1, chained: 1 });
  });

  it("exports a run's events with their hashes", () => {
    store.append([
      { type: "run.created", run_id: "run_1", task_id: null, actor: sys, payload: { repo_path: "/r", base_commit: "b", prompt: "p", budget: 1, adapter: "a", profile: "implementer", allow_commands: [] } } as NewEvent,
      note(1),
    ]);
    const events = store.auditEvents("run_1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "run.created", actor: sys });
    expect(events[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
