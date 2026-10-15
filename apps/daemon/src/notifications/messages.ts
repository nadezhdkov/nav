import type { Locale } from "@navarch/contracts";

/**
 * Notification texts in the Web UI's languages (ADR 0017). The daemon writes them because a
 * notification is shown by the phone's system, not by the app; the device's locale comes with
 * its push subscription. `{n}` is a count.
 */
export type NoticeKind = "approval" | "run_failed" | "budget_exceeded" | "paused_quota" | "pr_opened" | "run_done";
export type ApprovalSubject = "plan" | "pr" | "verification" | "agent";

interface Texts {
  title: Record<NoticeKind, string>;
  approval: Record<ApprovalSubject, string>;
  more: string;
  actions: { open: string; plan: string; diff: string };
}

export const MESSAGES: Record<Locale, Texts> = {
  en: {
    title: {
      approval: "Approval needed",
      run_failed: "Run failed",
      budget_exceeded: "Budget reached",
      paused_quota: "Run paused: quota",
      pr_opened: "Draft PR opened",
      run_done: "Run done",
    },
    approval: { plan: "Plan", pr: "Pull request", verification: "Verification", agent: "Agent start" },
    more: "{n} more in this run",
    actions: { open: "Open", plan: "View plan", diff: "View diff" },
  },
  "pt-BR": {
    title: {
      approval: "Aprovação pendente",
      run_failed: "Run falhou",
      budget_exceeded: "Orçamento atingido",
      paused_quota: "Run pausada: cota",
      pr_opened: "PR rascunho aberto",
      run_done: "Run concluída",
    },
    approval: { plan: "Plano", pr: "Pull request", verification: "Verificação", agent: "Início do agente" },
    more: "mais {n} nesta run",
    actions: { open: "Abrir", plan: "Ver plano", diff: "Ver diff" },
  },
  es: {
    title: {
      approval: "Aprobación pendiente",
      run_failed: "La run falló",
      budget_exceeded: "Presupuesto alcanzado",
      paused_quota: "Run en pausa: cuota",
      pr_opened: "PR borrador abierto",
      run_done: "Run terminada",
    },
    approval: { plan: "Plan", pr: "Pull request", verification: "Verificación", agent: "Inicio del agente" },
    more: "{n} más en esta run",
    actions: { open: "Abrir", plan: "Ver plan", diff: "Ver diff" },
  },
  de: {
    title: {
      approval: "Freigabe nötig",
      run_failed: "Run fehlgeschlagen",
      budget_exceeded: "Budget erreicht",
      paused_quota: "Run pausiert: Kontingent",
      pr_opened: "Entwurfs-PR geöffnet",
      run_done: "Run fertig",
    },
    approval: { plan: "Plan", pr: "Pull Request", verification: "Prüfung", agent: "Agent-Start" },
    more: "{n} weitere in diesem Run",
    actions: { open: "Öffnen", plan: "Plan ansehen", diff: "Diff ansehen" },
  },
  "zh-CN": {
    title: {
      approval: "需要审批",
      run_failed: "运行失败",
      budget_exceeded: "已达预算",
      paused_quota: "运行已暂停：配额",
      pr_opened: "已打开草稿 PR",
      run_done: "运行完成",
    },
    approval: { plan: "计划", pr: "拉取请求", verification: "验证", agent: "启动代理" },
    more: "此运行中还有 {n} 项",
    actions: { open: "打开", plan: "查看计划", diff: "查看差异" },
  },
};

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}
