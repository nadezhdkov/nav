import { join } from "node:path";
import type { InboxItemView, NavarchEvent } from "@navarch/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { EventStore } from "../src/events/store.ts";
import { noticeFor, render } from "../src/notifications/notifier.ts";
import { SummaryService } from "../src/summary/service.ts";

let store: EventStore;
beforeEach(() => {
  store = new EventStore(join(tempHome(), "navarch.db"));
});
afterEach(() => store.close());

function item(n: number, over: Partial<InboxItemView> = {}): InboxItemView {
  return {
    id: `wi_${n}`,
    project_id: "prj_1",
    source: "github",
    repo: "o/r",
    number: n,
    url: `https://github.com/o/r/issues/${n}`,
    title: `Issue ${n}`,
    labels: [],
    author: "a",
    status: "triaged",
    triage: { kind: "bug", complexity: 2, area: "cli", duplicate_of: null, suggested_action: "start_run", reason: "small" },
    triage_model: "m",
    estimate: { usd: 0.5, runs: 3 },
    runs: [],
    updated_at: "2026-10-20T03:00:00.000Z",
    ...over,
  };
}

function service(items: InboxItemView[], now: Date, summary: Record<string, unknown> = { enabled: true }) {
  let refreshed = 0;
  const svc = new SummaryService({
    config: Config.parse({ summary }),
    store,
    items: () => items,
    refresh: async () => void refreshed++,
    now: () => now,
  });
  return { svc, refreshed: () => refreshed };
}

describe("morning summary", () => {
  it("lists new items, suggestions and their estimate, ignoring dismissed ones", () => {
    const items = [
      item(1),
      item(2, { triage: { kind: "feature", complexity: 5, area: "x", duplicate_of: null, suggested_action: "start_run", reason: "big" }, estimate: null }),
      item(3, { triage: { kind: "bug", complexity: 1, area: "x", duplicate_of: 1, suggested_action: "duplicate", reason: "dup" } }),
      item(4, { status: "dismissed" }),
      item(5, { updated_at: "2026-10-18T00:00:00.000Z" }),
    ];
    const s = service(items, new Date("2026-10-20T08:00:00")).svc.build();
    expect(s.new_total).toBe(3);
    expect(s.new_items.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(s.duplicates).toBe(1);
    expect(s.suggestions.map((i) => i.number)).toEqual([1, 5]);
    expect(s.suggestions_estimate_usd).toBe(1);
  });

  it("makes one summary a day, at or after the configured time, after a refresh", async () => {
    const early = service([item(1)], new Date("2026-10-20T07:59:00"));
    expect(await early.svc.tick()).toBeUndefined();
    expect(early.refreshed()).toBe(0);

    const due = service([item(1)], new Date("2026-10-20T08:01:00"));
    const made = await due.svc.tick();
    expect(made?.new_total).toBe(1);
    expect(due.refreshed()).toBe(1);
    expect(due.svc.latest()?.id).toBe(made?.id);
    expect(await due.svc.tick()).toBeUndefined();

    const tomorrow = service([item(1)], new Date("2026-10-21T08:01:00"));
    const next = await tomorrow.svc.tick();
    expect(next?.since).toBe(made?.generated_at);
  });

  it("is quiet when disabled, and the notification carries counts only", async () => {
    const off = service([], new Date("2026-10-20T09:00:00"), {});
    off.svc.start();
    await off.svc.stop();
    expect(off.svc.latest()).toBeUndefined();

    const s = await service([item(1)], new Date("2026-10-20T09:00:00")).svc.generate();
    const notice = noticeFor({ type: "summary.generated", payload: s, run_id: null } as unknown as NavarchEvent);
    expect(notice).toMatchObject({ kind: "summary", url: "/home" });
    const message = render(notice!, 0, undefined, "pt-BR");
    expect(message.title).toBe("Resumo da manhã");
    expect(message.body).toContain("1 new");
  });
});
