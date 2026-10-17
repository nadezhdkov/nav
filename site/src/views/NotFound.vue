<script setup lang="ts">
import { asset } from "../lib/site.ts";
</script>

<template>
  <section class="mx-auto flex max-w-xl flex-col items-center px-4 py-28 text-center">
    <img :src="asset('mascot.png')" alt="" class="h-24 w-24 object-contain opacity-90" />
    <p class="eyebrow mt-6">404</p>
    <h1 class="mt-2 text-3xl font-bold tracking-tight">This page sailed off.</h1>
    <p class="mt-3 text-muted">The link may be old, or the page moved.</p>
    <div class="mt-8 flex gap-3">
      <RouterLink to="/" class="rounded-xl bg-accent px-5 py-3 font-semibold text-accent-ink">Home</RouterLink>
      <RouterLink to="/docs/introduction" class="rounded-xl border border-border px-5 py-3 font-semibold">Docs</RouterLink>
    </div>
  </section>
</template>
