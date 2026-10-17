/** The docs, in reading order. Each page is `src/docs/<slug>.md`, rendered at build time. */
export const DOC_SECTIONS = [
  { title: "Start", pages: ["introduction", "getting-started", "first-issue-run"] },
  { title: "Concepts", pages: ["how-it-works", "flows", "autonomy-and-approvals"] },
  { title: "Agents", pages: ["agents", "budgets-and-quotas"] },
  { title: "Use it", pages: ["web-ui", "phone", "cli", "concierge", "team-and-compete"] },
  { title: "Reference", pages: ["configuration", "security"] },
] as const;

type Doc = { html: string; title: string; headings: { level: number; id: string; text: string }[] };

const modules = import.meta.glob<Doc>("./*.md", { eager: true, import: "default" });

export const DOCS: Record<string, Doc> = Object.fromEntries(
  Object.entries(modules).map(([path, doc]) => [path.slice(2, -3), doc]),
);

export const DOC_ORDER: string[] = DOC_SECTIONS.flatMap((s) => [...s.pages]);
