<script setup lang="ts">
import GithubIcon from "./GithubIcon.vue";
import { Menu, X } from "@lucide/vue";
import { ref, watch } from "vue";
import { useRoute } from "vue-router";
import { GITHUB } from "../lib/site.ts";
import LogoMark from "./LogoMark.vue";

const open = ref(false);
const route = useRoute();
watch(() => route.fullPath, () => (open.value = false));

const links = [
  { to: "/docs/introduction", label: "Docs", match: "/docs" },
  { to: "/download", label: "Download", match: "/download" },
  { to: "/#how", label: "How it works", match: "" },
  { to: "/#faq", label: "FAQ", match: "" },
];
const active = (match: string) => match !== "" && route.path.startsWith(match);
</script>

<template>
  <header class="sticky top-0 z-40 border-b border-border/70 bg-bg/75 backdrop-blur-xl">
    <a href="#main" class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
    <nav class="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6" aria-label="Main">
      <RouterLink to="/" class="flex items-center gap-2.5 font-semibold tracking-tight">
        <LogoMark />
        <span class="text-[1.05rem]">Navarch</span>
      </RouterLink>
      <ul class="hidden items-center gap-1 md:flex">
        <li v-for="l in links" :key="l.label">
          <RouterLink
            :to="l.to"
            class="rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:text-text"
            :class="{ 'text-text': active(l.match) }"
            :aria-current="active(l.match) ? 'page' : undefined"
            >{{ l.label }}</RouterLink
          >
        </li>
      </ul>
      <div class="ml-auto hidden items-center gap-2 md:flex">
        <a :href="GITHUB" target="_blank" rel="noopener" class="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:text-text">
          <GithubIcon :size="16" aria-hidden="true" /> GitHub
        </a>
        <RouterLink to="/download" class="rounded-lg bg-accent px-3.5 py-1.5 text-sm font-semibold text-accent-ink transition hover:brightness-110">Get started</RouterLink>
      </div>
      <button
        type="button"
        class="ml-auto grid h-11 w-11 place-items-center rounded-lg border border-border md:hidden"
        :aria-expanded="open"
        aria-controls="mobile-menu"
        :aria-label="open ? 'Close menu' : 'Open menu'"
        @click="open = !open"
      >
        <X v-if="open" :size="20" aria-hidden="true" />
        <Menu v-else :size="20" aria-hidden="true" />
      </button>
    </nav>
    <div v-if="open" id="mobile-menu" class="border-t border-border bg-bg px-4 pb-4 md:hidden">
      <RouterLink v-for="l in links" :key="l.label" :to="l.to" class="block border-b border-border/60 py-3 text-base">{{ l.label }}</RouterLink>
      <a :href="GITHUB" target="_blank" rel="noopener" class="flex items-center gap-2 py-3 text-base"><GithubIcon :size="18" aria-hidden="true" /> GitHub</a>
      <RouterLink to="/download" class="mt-2 block rounded-lg bg-accent py-3 text-center font-semibold text-accent-ink">Get started</RouterLink>
    </div>
  </header>
</template>
