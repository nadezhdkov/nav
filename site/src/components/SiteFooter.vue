<script setup lang="ts">
import { GITHUB } from "../lib/site.ts";
import LogoMark from "./LogoMark.vue";

const columns = [
  {
    title: "Product",
    links: [
      { label: "Download", to: "/download" },
      { label: "How it works", to: "/docs/how-it-works" },
      { label: "Agents", to: "/docs/agents" },
      { label: "Web UI", to: "/docs/web-ui" },
    ],
  },
  {
    title: "Docs",
    links: [
      { label: "Getting started", to: "/docs/getting-started" },
      { label: "CLI", to: "/docs/cli" },
      { label: "Configuration", to: "/docs/configuration" },
      { label: "Security", to: "/docs/security" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "GitHub", href: GITHUB },
      { label: "Decisions (ADRs)", href: `${GITHUB}/tree/main/docs/adr` },
      { label: "Contributing", href: `${GITHUB}/blob/main/CONTRIBUTING.md` },
      { label: "Report a bug", href: `${GITHUB}/issues` },
    ],
  },
];
</script>

<template>
  <footer class="border-t border-border bg-surface/40">
    <div class="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
      <div>
        <RouterLink to="/" class="flex items-center gap-2.5 font-semibold"><LogoMark /> Navarch</RouterLink>
        <p class="mt-3 max-w-xs text-sm text-muted">A local-first coordinator for the coding agents you already use. Open source under the MIT license.</p>
      </div>
      <nav v-for="col in columns" :key="col.title" :aria-label="col.title">
        <h2 class="eyebrow mb-3 !text-muted">{{ col.title }}</h2>
        <ul class="space-y-2 text-sm">
          <li v-for="l in col.links" :key="l.label">
            <RouterLink v-if="'to' in l" :to="l.to!" class="text-muted transition-colors hover:text-text">{{ l.label }}</RouterLink>
            <a v-else :href="l.href" target="_blank" rel="noopener" class="text-muted transition-colors hover:text-text">{{ l.label }}</a>
          </li>
        </ul>
      </nav>
    </div>
    <div class="border-t border-border">
      <p class="mx-auto max-w-6xl px-4 py-5 font-mono text-xs text-muted sm:px-6">MIT licensed · Your code, your keys and your agents stay on your machine.</p>
    </div>
  </footer>
</template>
