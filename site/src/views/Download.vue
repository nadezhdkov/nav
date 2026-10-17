<script setup lang="ts">
import GithubIcon from "../components/GithubIcon.vue";
import { ArrowRight, Check, Package } from "@lucide/vue";
import CopyButton from "../components/CopyButton.vue";
import InstallBlock from "../components/InstallBlock.vue";
import { reveal as vReveal } from "../lib/reveal.ts";
import { AGENTS, GITHUB } from "../lib/site.ts";

const REQUIREMENTS = ["Node.js 22.18 or later", "pnpm", "git", "At least one agent CLI, signed in (below)", "For issue runs: a fine-grained GitHub token"];
const UPDATE = "git pull && make install && make web-build";
</script>

<template>
  <section class="relative overflow-hidden border-b border-border">
    <div class="dot-field pointer-events-none absolute inset-0" aria-hidden="true" />
    <div class="relative mx-auto max-w-4xl px-4 py-20 text-center sm:px-6">
      <p class="eyebrow" v-reveal>Download</p>
      <h1 class="mt-3 text-4xl font-bold tracking-tight sm:text-6xl" v-reveal="60">Install Navarch</h1>
      <p class="mx-auto mt-5 max-w-2xl text-lg text-muted" v-reveal="120">
        Navarch installs from source for now: one clone, two make targets, and the CLI is ready. Packaged releases will follow.
      </p>
      <div class="mt-10" v-reveal="180"><InstallBlock /></div>
    </div>
  </section>

  <section class="mx-auto grid max-w-6xl gap-6 px-4 py-20 sm:px-6 lg:grid-cols-3">
    <div class="card p-6" v-reveal>
      <h2 class="font-semibold tracking-tight">Requirements</h2>
      <ul class="mt-4 space-y-2.5 text-sm">
        <li v-for="r in REQUIREMENTS" :key="r" class="flex gap-2"><Check :size="17" class="mt-0.5 shrink-0 text-success" aria-hidden="true" /> {{ r }}</li>
      </ul>
      <p class="mt-4 text-sm text-muted">Navarch is developed on Linux. It runs where Node.js and git run, but macOS and Windows are not tested regularly yet.</p>
    </div>
    <div class="card p-6" v-reveal="80">
      <h2 class="font-semibold tracking-tight">Update</h2>
      <p class="mt-3 text-sm text-muted">Pull the latest main and reinstall. Restart the daemon afterwards.</p>
      <div class="mt-4 flex items-center justify-between gap-2 rounded-lg border border-border bg-bg/60 py-1.5 pl-3 pr-1.5">
        <code class="overflow-x-auto whitespace-nowrap font-mono text-[0.8rem]">{{ UPDATE }}</code>
        <CopyButton :text="UPDATE" />
      </div>
      <p class="mt-4 text-sm text-muted">Your runs, approvals and settings live in <code class="font-mono">~/.navarch</code> and survive updates.</p>
    </div>
    <div class="card flex flex-col p-6" v-reveal="160">
      <h2 class="font-semibold tracking-tight">Packaged releases</h2>
      <p class="mt-3 text-sm text-muted">npm packages and installers are not published yet. Watch the repository to hear when the first release lands.</p>
      <div class="mt-auto flex flex-wrap gap-2 pt-5">
        <a :href="GITHUB" target="_blank" rel="noopener" class="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:border-edge"><GithubIcon :size="16" aria-hidden="true" /> Watch on GitHub</a>
        <a :href="`${GITHUB}/releases`" target="_blank" rel="noopener" class="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:border-edge"><Package :size="16" aria-hidden="true" /> Releases</a>
      </div>
    </div>
  </section>

  <section class="mx-auto max-w-6xl px-4 pb-24 sm:px-6" aria-labelledby="agents-title">
    <h2 id="agents-title" class="text-2xl font-bold tracking-tight sm:text-3xl" v-reveal>Sign in to an agent</h2>
    <p class="mt-2 max-w-2xl text-muted" v-reveal="60">Navarch drives agent CLIs you install and sign in to yourself. One is enough to start; with several, the Model Router spreads the work.</p>
    <div class="card mt-8 overflow-x-auto" v-reveal="120">
      <table class="w-full min-w-[40rem] text-left text-sm">
        <thead class="border-b border-border text-xs uppercase tracking-wider text-muted">
          <tr>
            <th scope="col" class="px-5 py-3 font-semibold">Agent</th>
            <th scope="col" class="px-5 py-3 font-semibold">Navarch runs</th>
            <th scope="col" class="px-5 py-3 font-semibold">Sign-in</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          <tr v-for="a in AGENTS" :key="a.id">
            <th scope="row" class="px-5 py-3 font-semibold">{{ a.name }} <span class="ml-1 font-mono text-xs font-normal text-muted">{{ a.id }}</span></th>
            <td class="px-5 py-3 font-mono text-xs">{{ a.runs }}</td>
            <td class="px-5 py-3 text-muted">{{ a.signIn }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <RouterLink to="/docs/agents" class="mt-6 inline-flex items-center gap-1.5 font-semibold text-accent hover:underline" v-reveal>More about agents and routing <ArrowRight :size="16" aria-hidden="true" /></RouterLink>
  </section>
</template>
