import { z } from "zod";

/**
 * Sessions (ADR 0074): a live conversation with Claude Code in a registered project, driven from the
 * Web UI or a paired phone. Unlike a run it has no Flow: the user talks, the agent answers, and each
 * permission the agent asks for is answered by the user.
 */

export const SessionStatus = z.enum(["starting", "idle", "working", "waiting", "closed"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionPermissionMode = z.enum(["default", "acceptEdits"]);
export type SessionPermissionMode = z.infer<typeof SessionPermissionMode>;

/** One line of the transcript. Text from the agent, from tools and from files is plain text to show, never markup. */
export const SessionItem = z.object({
  seq: z.number().int().positive(),
  ts: z.string(),
  kind: z.enum(["user", "assistant", "tool", "permission", "notice"]),
  text: z.string(),
  /** For `tool` and `permission`: the tool's name. */
  tool: z.string().optional(),
  /** For `permission`: what the agent asked, and the answer so far. */
  request_id: z.string().optional(),
  status: z.enum(["pending", "allowed", "denied", "expired"]).optional(),
});
export type SessionItem = z.infer<typeof SessionItem>;

export const SessionView = z.object({
  id: z.string(),
  project_id: z.string(),
  project_name: z.string(),
  path: z.string(),
  status: SessionStatus,
  permission_mode: SessionPermissionMode,
  opened_at: z.string(),
  last_activity: z.string(),
  /** What Claude Code reported for the session so far, API-equivalent (plan use is not billed). */
  cost_usd: z.number(),
  /** Permission questions waiting for the user. */
  pending: z.number().int().nonnegative(),
  /** Claude Code's own session id, to reopen the conversation later. */
  claude_session_id: z.string().nullable(),
  closed_reason: z.string().nullable(),
});
export type SessionView = z.infer<typeof SessionView>;

export const SessionDetail = SessionView.extend({
  /** Items after the requested `seq`, oldest first. */
  items: z.array(SessionItem),
  /** The answer being written right now, not final yet. */
  live: z.string().nullable(),
  /** The newest item's `seq`, for the next poll. */
  seq: z.number().int().nonnegative(),
});
export type SessionDetail = z.infer<typeof SessionDetail>;

export const SessionsListing = z.object({
  /** `sessions.enabled` in the daemon's config, which only the PC sets. */
  enabled: z.boolean(),
  sessions: z.array(SessionView),
});
export type SessionsListing = z.infer<typeof SessionsListing>;

export const OpenSessionRequest = z.strictObject({
  project_id: z.string().min(1),
  permission_mode: SessionPermissionMode.optional(),
  /** An earlier session of this daemon to continue (its Claude Code conversation). */
  resume: z.string().min(1).optional(),
});
export type OpenSessionRequest = z.infer<typeof OpenSessionRequest>;

export const SESSION_LIMITS = { textChars: 20_000, images: 3, imageBase64Chars: 2_800_000 } as const;

export const SessionMessageRequest = z.strictObject({
  text: z.string().min(1).max(SESSION_LIMITS.textChars),
  images: z
    .array(z.strictObject({ media_type: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]), data: z.string().regex(/^[A-Za-z0-9+/]+=*$/).max(SESSION_LIMITS.imageBase64Chars) }))
    .max(SESSION_LIMITS.images)
    .default([]),
});
export type SessionMessageRequest = z.input<typeof SessionMessageRequest>;

export const SessionPermissionRequest = z.strictObject({ decision: z.enum(["allow", "deny"]), message: z.string().max(500).optional() });
export type SessionPermissionRequest = z.infer<typeof SessionPermissionRequest>;
