import { Bot, Flag, GitPullRequestDraft, Hand, Repeat, Swords, Users, Workflow, Zap } from "@lucide/vue";
import type { Component } from "vue";

/** Icon and accent per node type (spec §15.4: accents by kind, never colour alone). */
export const kindIcon: Record<string, Component> = {
  trigger: Flag,
  agent: Bot,
  action: Zap,
  github: GitPullRequestDraft,
  approval: Hand,
  loop: Repeat,
  team: Users,
  compete: Swords,
  subflow: Workflow,
};

export const kindTone: Record<string, string> = {
  trigger: "neutral",
  agent: "info",
  action: "success",
  github: "neutral",
  approval: "warning",
  loop: "neutral",
  team: "info",
  compete: "info",
  subflow: "neutral",
};
