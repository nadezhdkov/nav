import { z } from "zod";

/** Scheduled runs (spec §7.4, UC-14, ADR 0064): a prompt run started on a timetable in a registered project. */

export const ScheduleDay = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type ScheduleDay = z.infer<typeof ScheduleDay>;
export const SCHEDULE_DAYS: ScheduleDay[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Local time of the PC, 24 h. */
export const ScheduleAt = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24 h");

/** What the user sets. A budget is required: nobody is watching when it runs. */
export const SaveScheduleRequest = z.object({
  name: z.string().trim().min(1).max(60),
  project_id: z.string().min(1),
  prompt: z.string().trim().min(3).max(4_000),
  /** A Flow that starts from a prompt; the default is `task`. */
  flow: z.string().regex(/^[\w.-]{1,60}$/).optional(),
  budget: z.number().positive().max(1_000),
  at: ScheduleAt,
  days: z.array(ScheduleDay).min(1).max(7),
  enabled: z.boolean().default(true),
});
export type SaveScheduleRequest = z.infer<typeof SaveScheduleRequest>;

/** Pause or resume without touching the rest. */
export const SetScheduleEnabledRequest = z.object({ enabled: z.boolean() });
export type SetScheduleEnabledRequest = z.infer<typeof SetScheduleEnabledRequest>;

export const ScheduleSkipReason = z.enum(["missed", "still_running", "daily_cap", "refused", "failed", "project_removed"]);
export type ScheduleSkipReason = z.infer<typeof ScheduleSkipReason>;

export const ScheduleView = z.object({
  id: z.string(),
  name: z.string(),
  project_id: z.string(),
  repo: z.string().nullable(),
  prompt: z.string(),
  flow: z.string().nullable(),
  budget: z.number(),
  at: z.string(),
  days: z.array(ScheduleDay),
  enabled: z.boolean(),
  /** The next time it will start (ISO), or null while paused. */
  next_at: z.string().nullable(),
  /** The last slot it looked at (`YYYY-MM-DD HH:MM`, local) and what came of it. */
  last_slot: z.string().nullable(),
  last_outcome: z.enum(["started", ...ScheduleSkipReason.options]).nullable(),
  last_run_id: z.string().nullable(),
  last_message: z.string().nullable(),
});
export type ScheduleView = z.infer<typeof ScheduleView>;
