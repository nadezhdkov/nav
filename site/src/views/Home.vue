<script setup lang="ts">
import GithubIcon from "../components/GithubIcon.vue";
import {
  ArrowRight,
  Bell,
  ChevronDown,
  FileClock,
  GitBranch,
  Hand,
  Route,
  ScrollText,
  ShieldCheck,
  Trophy,
  Users,
  Wallet,
  Workflow,
} from "@lucide/vue";
import AgentMarquee from "../components/AgentMarquee.vue";
import HeroFlow from "../components/HeroFlow.vue";
import InstallBlock from "../components/InstallBlock.vue";
import Showcase from "../components/Showcase.vue";
import TeamSample from "../components/TeamSample.vue";
import TerminalDemo from "../components/TerminalDemo.vue";
import { reveal as vReveal } from "../lib/reveal.ts";
import { asset, GITHUB } from "../lib/site.ts";

const STEPS = [
  { n: "01", title: "Pick the work", text: "A GitHub issue, a pull request with failing checks, an item from your Inbox, or a plain prompt in any local repository." },
  { n: "02", title: "Plan, then approve", text: "A fast agent triages, a stronger one plans. Below autonomy level 3 the plan waits for you, with what will happen and what it costs." },
  { n: "03", title: "Agents work in isolation", text: "Each run gets its own branch and git worktree. The implementer edits, your project's checks verify, and failures loop back up to three times." },
  { n: "04", title: "You review a draft PR", text: "A reviewer from another provider reads the diff, and Navarch opens a draft PR with the plan, evidence and cost. You merge. Navarch never does." },
];

const FEATURES = [
  { icon: GitBranch, title: "One worktree per run", text: "Agents never touch your checkout. Branches are always navarch/*, pushed without force." },
  { icon: Hand, title: "Approvals where you want them", text: "Autonomy levels 0–3 per repository decide whether a human approves before agents, edits, the plan or the PR." },
  { icon: Route, title: "A router across your agents", text: "Fast models for triage, stronger ones for plans, a reviewer from another provider, and rate limits that fall back at once." },
  { icon: Wallet, title: "Budgets that hold", text: "Per run, per project per day and per month. Plan subscriptions are tracked apart from metered API spend." },
  { icon: ScrollText, title: "Everything is an event", text: "Every decision, command and cost lands in a local append-only log. The CLI, Web UI and phone read the same state." },
  { icon: Users, title: "Team mode", text: "A lead agent splits the work, delegates members in dependency order or in parallel worktrees, and merges what they made." },
  { icon: Trophy, title: "Compete mode", text: "Give the same task to up to five agents at once. A judge on another provider ranks the finalists, and you pick the winner." },
  { icon: Workflow, title: "Flow Studio", text: "Build your own Flows on a canvas or in YAML, with live validation and a simulator, then publish versions you can run." },
  { icon: Bell, title: "Your phone in the loop", text: "Install the UI as an app over Tailscale. Get a push when an approval waits, then decide on the screen it links to." },
];

const NEVER = [
  "merge, release or deploy on its own",
  "push to a branch outside navarch/*, or force a push",
  "let agents write outside their worktree or read ~/.ssh",
  "take issue, PR or comment text as instructions",
  "put a secret in a log, an event or a config file",
  "spend past a budget without asking you first",
];

const FAQ = [
  { q: "Is Navarch another coding agent?", a: "No. It orchestrates the agents you already use: it gives them a plan, an isolated worktree, a budget, rules and a human in the loop, and records everything they do." },
  { q: "Does my code leave my machine?", a: "Navarch's daemon runs on your computer and listens only on 127.0.0.1. Your agents talk to their own providers as they always do. Navarch itself only talks to GitHub, through one integration that uses your fine-grained token." },
  { q: "What does it cost?", a: "Navarch is free and open source under the MIT license. You pay for the agent plans and API keys you already have. Budgets cap billed API use, and free models (OpenCode Zen, OpenRouter free models, Ollama) work too." },
  { q: "Will it merge or push to main?", a: "Never. Runs push only navarch/* branches, never forced, and pull requests are always drafts. Merging is yours." },
  { q: "Which agents does it support?", a: "Claude Code, Codex, Gemini CLI, Antigravity, GitHub Copilot CLI, OpenCode, Kilo CLI, Grok CLI, and local or API models through Navarch's own tool loop (Ollama, OpenRouter, OpenCode Zen)." },
  { q: "Can I use it from my phone?", a: "Yes. The Web UI installs as an app (PWA). Tailscale gives the daemon your tailnet's HTTPS name while it stays on loopback, and a paired phone gets its own short-lived, revocable session." },
  { q: "Is it ready?", a: "Navarch is young and moves fast: issue → verified draft PR works end to end, and the first Phase 2 features (parallel teams, Compete mode, Flow Studio) are in. Expect rough edges, and tell us about them on GitHub." },
];

const PHONES = [
  { src: "shots/mobile-home.png", alt: "Phone Home: an approval waiting, New run, the Stop everything button, the Inbox and today's cost" },
  { src: "shots/mobile-approvals.png", alt: "Phone approval of a team plan: what will happen, why, the cost, and Approve or Reject" },
  { src: "shots/mobile-fleet.png", alt: "Phone Fleet: each run's step progress and agent cards with status as icon and text" },
];
</script>

<template>
  <!-- Hero -->
  <section class="relative overflow-hidden">
    <div class="dot-field pointer-events-none absolute inset-0" aria-hidden="true" />
    <div class="glow pointer-events-none absolute left-1/2 top-[-12rem] h-[34rem] w-[60rem] -translate-x-1/2 rounded-full" aria-hidden="true" />
    <div class="relative mx-auto max-w-6xl px-4 pb-16 pt-16 text-center sm:px-6 sm:pt-24">
      <p class="eyebrow" v-reveal>Open source · Local-first · Bring your own agents</p>
      <h1 class="mx-auto mt-5 max-w-4xl text-[2.6rem] font-bold leading-[1.04] tracking-[-0.035em] sm:text-6xl lg:text-7xl" v-reveal="80">
        Command your <span class="shimmer">fleet</span> of coding agents.
      </h1>
      <p class="mx-auto mt-6 max-w-2xl text-lg text-muted sm:text-xl" v-reveal="160">
        Navarch turns GitHub issues into verified draft PRs with the agents you already use. Each run gets its own worktree, a policy, approvals and a full event log.
      </p>
      <div class="mt-9 flex flex-wrap items-center justify-center gap-3" v-reveal="240">
        <RouterLink to="/download" class="group flex h-12 items-center gap-2 rounded-xl bg-accent px-5 font-semibold text-accent-ink transition hover:brightness-110">
          Get started <ArrowRight :size="18" class="transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </RouterLink>
        <a :href="GITHUB" target="_blank" rel="noopener" class="flex h-12 items-center gap-2 rounded-xl border border-border bg-surface/70 px-5 font-semibold transition hover:border-edge">
          <GithubIcon :size="18" aria-hidden="true" /> View on GitHub
        </a>
      </div>
      <p class="mt-5 font-mono text-xs text-muted" v-reveal="300">MIT · runs on your machine · never merges for you</p>
      <div class="mx-auto mt-14 max-w-6xl" v-reveal="200">
        <HeroFlow />
      </div>
    </div>
  </section>

  <!-- Agents -->
  <section class="border-y border-border bg-surface/30 py-10" aria-labelledby="agents-title">
    <h2 id="agents-title" class="mb-5 text-center font-mono text-xs uppercase tracking-[0.14em] text-muted">Works with the agents you already pay for</h2>
    <AgentMarquee />
  </section>

  <!-- How it works -->
  <section id="how" class="mx-auto max-w-6xl scroll-mt-20 px-4 py-24 sm:px-6" aria-labelledby="how-title">
    <p class="eyebrow" v-reveal>How it works</p>
    <h2 id="how-title" class="mt-3 max-w-2xl text-3xl font-bold tracking-tight sm:text-5xl" v-reveal="60">From issue to draft PR, with you at the gates.</h2>
    <ol class="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <li v-for="(s, i) in STEPS" :key="s.n" class="card group relative p-6" v-reveal="i * 90">
        <span class="font-mono text-sm text-accent">{{ s.n }}</span>
        <h3 class="mt-3 text-lg font-semibold tracking-tight">{{ s.title }}</h3>
        <p class="mt-2 text-sm leading-6 text-muted">{{ s.text }}</p>
        <ArrowRight v-if="i < STEPS.length - 1" :size="18" class="absolute -right-3 top-1/2 z-10 hidden -translate-y-1/2 rounded-full bg-bg text-edge lg:block" aria-hidden="true" />
      </li>
    </ol>
  </section>

  <!-- Features -->
  <section class="mx-auto max-w-6xl px-4 pb-24 sm:px-6" aria-labelledby="features-title">
    <p class="eyebrow" v-reveal>What you get</p>
    <h2 id="features-title" class="mt-3 max-w-2xl text-3xl font-bold tracking-tight sm:text-5xl" v-reveal="60">A control plane, not another agent.</h2>
    <div class="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <article v-for="(f, i) in FEATURES" :key="f.title" class="card feature p-6" v-reveal="(i % 3) * 80">
        <span class="grid h-10 w-10 place-items-center rounded-xl border border-border bg-surface-2 text-accent" aria-hidden="true">
          <component :is="f.icon" :size="20" />
        </span>
        <h3 class="mt-4 font-semibold tracking-tight">{{ f.title }}</h3>
        <p class="mt-1.5 text-sm leading-6 text-muted">{{ f.text }}</p>
      </article>
    </div>
  </section>

  <!-- Terminal -->
  <section class="border-y border-border bg-surface/30" aria-labelledby="cli-title">
    <div class="mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 sm:px-6 lg:grid-cols-[0.85fr_1.15fr]">
      <div class="min-w-0" v-reveal>
        <p class="eyebrow">From the terminal</p>
        <h2 id="cli-title" class="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Everything the UI does, the CLI does too.</h2>
        <p class="mt-4 text-muted">Start runs from a prompt or an issue, follow their logs, decide approvals, steer a running agent, pause or stop everything. Or run <code class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-sm">navarch</code> with no arguments and just ask: anything that changes something waits for your yes.</p>
        <RouterLink to="/docs/cli" class="mt-6 inline-flex items-center gap-1.5 font-semibold text-accent hover:underline">CLI reference <ArrowRight :size="16" aria-hidden="true" /></RouterLink>
      </div>
      <div class="min-w-0 space-y-4" v-reveal="120">
        <TerminalDemo />
        <figure class="card overflow-hidden p-1.5">
          <img :src="asset('shots/cli-banner.png')" alt="The navarch banner in a terminal: the mascot, a helm wheel and the name Navarch, then project, repository, AI model, workspace, branch and agents, System ready and the nav prompt" class="block h-auto w-full rounded-[10px]" loading="lazy" decoding="async" />
        </figure>
      </div>
    </div>
  </section>

  <!-- Web UI -->
  <section class="mx-auto max-w-6xl px-4 py-24 sm:px-6" aria-labelledby="ui-title">
    <div class="text-center">
      <p class="eyebrow" v-reveal>The Web UI</p>
      <h2 id="ui-title" class="mx-auto mt-3 max-w-2xl text-3xl font-bold tracking-tight sm:text-5xl" v-reveal="60">See every agent, live.</h2>
      <p class="mx-auto mt-4 max-w-2xl text-muted" v-reveal="120">Served by the daemon on your machine, updated over its event stream, in five languages, usable by keyboard.</p>
    </div>
    <div class="mt-10" v-reveal="160"><Showcase /></div>
  </section>

  <!-- Teams of teams -->
  <section class="mx-auto max-w-6xl px-4 py-24 sm:px-6" aria-labelledby="teams-title">
    <div class="grid items-center gap-12 lg:grid-cols-[0.85fr_1.15fr]">
      <div class="min-w-0" v-reveal>
        <p class="eyebrow">Team mode</p>
        <h2 id="teams-title" class="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">A lead, sub-leads and their teams.</h2>
        <p class="mt-4 text-muted">The lead splits the job. It can hand a whole area, such as the front end or the API, to a sub-lead that runs a small team of its own: frontend, backend, QA. Each sub-team works in its own worktree and merges up, so a failed part never takes the rest with it.</p>
        <RouterLink to="/docs/team-and-compete" class="mt-6 inline-flex items-center gap-1.5 font-semibold text-accent hover:underline">How teams work <ArrowRight :size="16" aria-hidden="true" /></RouterLink>
      </div>
      <div class="min-w-0" v-reveal="120"><TeamSample /></div>
    </div>
  </section>

  <!-- Phone -->
  <section class="relative overflow-hidden border-y border-border bg-surface/30" aria-labelledby="phone-title">
    <div class="mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 sm:px-6 lg:grid-cols-2">
      <div class="min-w-0" v-reveal>
        <p class="eyebrow">On your phone</p>
        <h2 id="phone-title" class="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Approve from anywhere. Your daemon stays home.</h2>
        <p class="mt-4 text-muted">The same UI installs as an app. Tailscale reaches the daemon over your tailnet while it keeps listening on loopback. Pair with a QR code, get a push when something needs you, and approve, pause or stop everything from the couch.</p>
        <ul class="mt-6 space-y-2 text-sm">
          <li class="flex gap-2"><ShieldCheck :size="18" class="shrink-0 text-success" aria-hidden="true" /> Short-lived sessions, revocable at any time, no secrets on the phone</li>
          <li class="flex gap-2"><Bell :size="18" class="shrink-0 text-success" aria-hidden="true" /> Notifications only link: deciding happens on the approval screen</li>
        </ul>
      </div>
      <div class="phones relative flex justify-center gap-3 sm:gap-5" v-reveal="120">
        <figure v-for="(p, i) in PHONES" :key="p.src" class="phone" :style="{ '--i': i }">
          <img :src="asset(p.src)" :alt="p.alt" class="block h-auto w-full" loading="lazy" decoding="async" />
        </figure>
      </div>
    </div>
  </section>

  <!-- Guarantees -->
  <section class="mx-auto max-w-6xl px-4 py-24 sm:px-6" aria-labelledby="never-title">
    <div class="grid gap-12 lg:grid-cols-[0.9fr_1.1fr]">
      <div v-reveal>
        <p class="eyebrow">Safe by default</p>
        <h2 id="never-title" class="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Every side effect goes through a policy.</h2>
        <p class="mt-4 text-muted">Agents run with Navarch's configuration, not yours, and only the commands your project allows. Content from issues and PRs is treated as untrusted data. Secrets live in your OS keychain.</p>
        <RouterLink to="/docs/security" class="mt-6 inline-flex items-center gap-1.5 font-semibold text-accent hover:underline">Security model <ArrowRight :size="16" aria-hidden="true" /></RouterLink>
      </div>
      <div class="card p-6 sm:p-8" v-reveal="120">
        <h3 class="font-mono text-sm uppercase tracking-[0.12em] text-muted">Navarch will never</h3>
        <ul class="mt-5 divide-y divide-border">
          <li v-for="n in NEVER" :key="n" class="flex items-start gap-3 py-3">
            <ShieldCheck :size="18" class="mt-0.5 shrink-0 text-success" aria-hidden="true" />
            <span>{{ n }}</span>
          </li>
        </ul>
      </div>
    </div>
  </section>

  <!-- Install -->
  <section id="install" class="relative overflow-hidden border-y border-border bg-surface/30" aria-labelledby="install-title">
    <div class="dot-field pointer-events-none absolute inset-0 opacity-60" aria-hidden="true" />
    <div class="relative mx-auto max-w-3xl px-4 py-24 text-center sm:px-6">
      <p class="eyebrow" v-reveal>Get started</p>
      <h2 id="install-title" class="mt-3 text-3xl font-bold tracking-tight sm:text-5xl" v-reveal="60">Up and running in a few commands.</h2>
      <p class="mt-4 text-muted" v-reveal="120">You need Node.js 22.18 or later, pnpm, git, and at least one signed-in agent.</p>
      <div class="mt-10" v-reveal="160"><InstallBlock /></div>
      <div class="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm" v-reveal="200">
        <RouterLink to="/docs/getting-started" class="inline-flex items-center gap-1.5 font-semibold text-accent hover:underline">Getting started guide <ArrowRight :size="16" aria-hidden="true" /></RouterLink>
        <RouterLink to="/download" class="inline-flex items-center gap-1.5 text-muted hover:text-text">Requirements and agents <ArrowRight :size="16" aria-hidden="true" /></RouterLink>
      </div>
    </div>
  </section>

  <!-- FAQ -->
  <section id="faq" class="mx-auto max-w-3xl scroll-mt-20 px-4 py-24 sm:px-6" aria-labelledby="faq-title">
    <p class="eyebrow text-center" v-reveal>FAQ</p>
    <h2 id="faq-title" class="mt-3 text-center text-3xl font-bold tracking-tight sm:text-4xl" v-reveal="60">Questions, answered.</h2>
    <div class="mt-10 divide-y divide-border border-y border-border">
      <details v-for="f in FAQ" :key="f.q" class="faq group py-1">
        <summary class="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-left font-semibold">
          {{ f.q }}
          <ChevronDown :size="18" class="shrink-0 text-muted transition-transform duration-300 group-open:rotate-180" aria-hidden="true" />
        </summary>
        <p class="pb-5 pr-8 text-muted">{{ f.a }}</p>
      </details>
    </div>
  </section>

  <!-- Closing call to action -->
  <section class="relative overflow-hidden border-t border-border" aria-labelledby="cta-title">
    <div class="glow pointer-events-none absolute bottom-[-18rem] left-1/2 h-[30rem] w-[50rem] -translate-x-1/2 rounded-full" aria-hidden="true" />
    <div class="relative mx-auto flex max-w-3xl flex-col items-center px-4 py-24 text-center sm:px-6">
      <img :src="asset('mascot.png')" alt="" width="112" height="112" class="mascot h-28 w-28 rounded-3xl object-cover shadow-[0_18px_50px_-18px_var(--glow)] ring-1 ring-border" />
      <h2 id="cta-title" class="mt-6 text-3xl font-bold tracking-tight sm:text-5xl">Take command of your fleet.</h2>
      <p class="mt-4 max-w-xl text-muted">Free, open source, and yours to run. Start with one agent and one repository.</p>
      <div class="mt-8 flex flex-wrap justify-center gap-3">
        <RouterLink to="/download" class="flex h-12 items-center gap-2 rounded-xl bg-accent px-5 font-semibold text-accent-ink transition hover:brightness-110">
          Get started <ArrowRight :size="18" aria-hidden="true" />
        </RouterLink>
        <RouterLink to="/docs/introduction" class="flex h-12 items-center gap-2 rounded-xl border border-border bg-surface/70 px-5 font-semibold transition hover:border-edge">
          <FileClock :size="18" aria-hidden="true" /> Read the docs
        </RouterLink>
        <a :href="GITHUB" target="_blank" rel="noopener" class="flex h-12 items-center gap-2 rounded-xl border border-border bg-surface/70 px-5 font-semibold transition hover:border-edge">
          <GithubIcon :size="18" /> Star on GitHub
        </a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.glow {
  background: radial-gradient(closest-side, var(--glow), transparent);
}
.shimmer {
  background: linear-gradient(100deg, var(--accent) 20%, #a5f3fc 40%, var(--accent) 60%);
  background-size: 220% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: shimmer 5s ease-in-out infinite;
}
@media (prefers-color-scheme: light) {
  .shimmer {
    background-image: linear-gradient(100deg, var(--accent) 20%, #22d3ee 40%, var(--accent) 60%);
  }
}
@keyframes shimmer {
  0%,
  100% {
    background-position: 100% 0;
  }
  50% {
    background-position: 0 0;
  }
}
.feature {
  transition:
    border-color 0.3s,
    transform 0.3s;
}
.feature:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  transform: translateY(-3px);
}
.phone {
  width: min(30%, 13rem);
  margin: 0;
  overflow: hidden;
  border-radius: 1.6rem;
  border: 6px solid var(--surface-2);
  box-shadow: var(--shadow);
  animation: float 6s ease-in-out infinite;
  animation-delay: calc(var(--i) * -2s);
}
.phone:nth-child(2) {
  transform: translateY(-1.5rem);
}
@keyframes float {
  50% {
    translate: 0 -10px;
  }
}
.mascot {
  animation: wave 3.2s ease-in-out infinite;
  transform-origin: 50% 90%;
}
@keyframes wave {
  0%,
  60%,
  100% {
    rotate: 0deg;
  }
  70% {
    rotate: -6deg;
  }
  80% {
    rotate: 5deg;
  }
  90% {
    rotate: -3deg;
  }
}
.faq summary::-webkit-details-marker {
  display: none;
}
</style>
